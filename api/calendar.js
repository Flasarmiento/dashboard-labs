
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    })
  });
}

const db = admin.firestore();

const fail = (res, status, error) =>
  res.status(status).json({ ok: false, error });

const emailOK = s =>
  typeof s === 'string' &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

function evento(r) {
  if (
    typeof r.fecha !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(r.fecha)
  ) {
    throw Error('Fecha inválida');
  }

  const hora = o => {
    if (
      !o ||
      !Number.isInteger(o.hour) ||
      !Number.isInteger(o.minute) ||
      o.hour < 0 ||
      o.hour > 23 ||
      o.minute < 0 ||
      o.minute > 59
    ) {
      throw Error('Horario inválido');
    }

    return `${String(o.hour).padStart(2, '0')}:${String(o.minute).padStart(2, '0')}`;
  };

  const inicio =
    `${r.fecha}T${hora(r.inicio)}:00-03:00`;

  const fin =
    `${r.fecha}T${hora(r.fin)}:00-03:00`;

  if (
    !Number.isFinite(Date.parse(inicio)) ||
    Date.parse(fin) <= Date.parse(inicio)
  ) {
    throw Error('Rango horario inválido');
  }

  return {
    titulo: String(
      r.titulo || 'Reserva de laboratorio'
    ).slice(0, 250),

    inicio,
    fin,

    ubicacion: String(r.laboratorio || ''),
    descripcion: 'Reserva del Centro de Simulación'
  };
}

async function apps(payload) {
  const url = process.env.APPS_SCRIPT_URL;
  const secret = process.env.APPS_SCRIPT_SECRET;

  if (
    !url ||
    !secret ||
    !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)
  ) {
    throw Error('Apps Script no está configurado');
  }

  const r = await fetch(url, {
    method: 'POST',

    headers: {
      'Content-Type': 'text/plain;charset=utf-8'
    },

    body: JSON.stringify({
      ...payload,
      secret
    }),

    redirect: 'follow',

    signal: AbortSignal.timeout(25000)
  });

  if (!r.ok) {
    throw Error(
      'Google Apps Script no respondió correctamente'
    );
  }

  let out;

  try {
    out = JSON.parse(await r.text());
  } catch {
    throw Error('Apps Script no devolvió JSON');
  }

  if (out.ok !== true) {
    throw Error(
      out.error || 'Google rechazó la operación'
    );
  }

  return out;
}

function movimiento(accion, id, antes, despues, user) {
  const resumen = d =>
    d
      ? {
          titulo: d.titulo || '',
          laboratorio: d.laboratorio || '',
          fecha: d.fecha || '',
          inicio: d.inicio || null,
          fin: d.fin || null
        }
      : null;

  return {
    accion,
    reservaId: id,

    antes: resumen(antes),
    despues: resumen(despues),

    usuarioUid: user.uid,
    usuarioEmail: user.email || '',
    usuarioNombre: user.name || '',

    timestamp:
      admin.firestore.FieldValue.serverTimestamp()
  };
}

function validarCambios(c) {
  if (
    !c ||
    typeof c !== 'object' ||
    Array.isArray(c)
  ) {
    throw Error('Faltan cambios');
  }

  const keys = Object.keys(c);

  if (
    !keys.length ||
    keys.some(
      k =>
        ![
          'titulo',
          'laboratorio',
          'inicio',
          'fin'
        ].includes(k)
    )
  ) {
    throw Error('Cambio no permitido');
  }

  if (
    'titulo' in c &&
    (
      typeof c.titulo !== 'string' ||
      !c.titulo.trim() ||
      c.titulo.length > 250
    )
  ) {
    throw Error('Título inválido');
  }

  if (
    'laboratorio' in c &&
    (
      typeof c.laboratorio !== 'string' ||
      !c.laboratorio.trim() ||
      c.laboratorio.length > 100
    )
  ) {
    throw Error('Laboratorio inválido');
  }

  return c;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return fail(res, 405, 'Método no permitido');
  }

  const auth = req.headers.authorization || '';

  if (!auth.startsWith('Bearer ')) {
    return fail(res, 401, 'Falta autenticación');
  }

  let user;

  try {
    user = await admin.auth().verifyIdToken(
      auth.slice(7),
      true
    );
  } catch {
    return fail(res, 401, 'Sesión inválida');
  }

  try {
    const profile = await db
      .collection('usuarios')
      .doc(user.uid)
      .get();

    if (
      !profile.exists ||
      profile.data().rol !== 'admin' ||
      profile.data().activo === false
    ) {
      return fail(
        res,
        403,
        'Solo administradores activos'
      );
    }

    const {
      accion = 'prueba',
      reservaId,
      invitados,
      cambios
    } = req.body || {};

    if (accion === 'prueba') {
      await apps({ accion: 'prueba' });

      return res.json({
        ok: true,
        mensaje:
          'Conexión segura con Google Apps Script correcta'
      });
    }

    if (
      ![
        'crear',
        'actualizar',
        'modificar',
        'cancelar'
      ].includes(accion)
    ) {
      return fail(
        res,
        400,
        'Acción desconocida'
      );
    }

    if (
      typeof reservaId !== 'string' ||
      !/^[\w-]{1,200}$/.test(reservaId)
    ) {
      return fail(
        res,
        400,
        'Reserva inválida'
      );
    }

    let correos;

    if (
      accion === 'crear' ||
      accion === 'actualizar'
    ) {
      if (
        !Array.isArray(invitados) ||
        invitados.length > 50 ||
        invitados.some(x => typeof x !== 'string')
      ) {
        return fail(
          res,
          400,
          'Destinatarios inválidos'
        );
      }

      correos = [
        ...new Set(
          invitados.map(
            x => x.trim().toLowerCase()
          )
        )
      ];

      if (
        (accion === 'crear' && !correos.length) ||
        correos.some(x => !emailOK(x))
      ) {
        return fail(
          res,
          400,
          'Revisá los correos electrónicos'
        );
      }
    }

    const ref = db
      .collection('reservas')
      .doc(reservaId);

    let original;
    let nuevo;
    let payload;

    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);

      if (!snap.exists) {
        throw Error('La reserva no existe');
      }

      original = snap.data();

      if (original.googleInviteState === 'pending') {
        throw Error(
          'Operación pendiente de verificación. Revisá Google Calendar.'
        );
      }

      if (
        accion === 'crear' &&
        original.googleEventId
      ) {
        throw Error('La invitación ya existe');
      }

      if (
        accion !== 'crear' &&
        (
          !original.googleEventId ||
          original.googleInviteState !== 'sent'
        )
      ) {
        throw Error(
          'La reserva no tiene invitación confirmada'
        );
      }

      nuevo =
        accion === 'modificar'
          ? {
              ...original,
              ...validarCambios(cambios)
            }
          : original;

      if (accion !== 'cancelar') {
        payload = evento(nuevo);
      }

      if (
        accion === 'actualizar' ||
        accion === 'modificar'
      ) {
        payload.eventoId = original.googleEventId;

        payload.invitados =
          accion === 'actualizar'
            ? correos
            : (original.googleInvitados || []);
      }

      if (accion === 'crear') {
        payload.invitados = correos;
      }

      if (accion === 'cancelar') {
        payload = {
          eventoId: original.googleEventId
        };
      }

      tx.update(ref, {
        googleInviteState: 'pending',

        googleInviteStartedAt:
          admin.firestore.FieldValue.serverTimestamp(),

        googleInviteStartedBy: user.uid
      });
    });

    let result;

    try {
      result = await apps({
        accion:
          accion === 'modificar'
            ? 'actualizar'
            : accion,

        ...payload
      });
    } catch (e) {
      console.error(
        'Operación Google de resultado incierto:',
        accion,
        reservaId,
        e
      );

      return fail(
        res,
        502,
        'No se pudo confirmar la operación. Revisá Google Calendar antes de reintentar; la reserva quedó protegida.'
      );
    }

    if (
      accion !== 'cancelar' &&
      !result.eventoId
    ) {
      return fail(
        res,
        502,
        'Google no devolvió el ID. Revisá Calendar antes de reintentar.'
      );
    }

    try {
      if (accion === 'cancelar') {
        await db.runTransaction(async tx => {
          const snap = await tx.get(ref);

          if (!snap.exists) {
            throw Error(
              'Reserva desaparecida después de cancelar Google'
            );
          }

          const mov = db
            .collection('movimientos')
            .doc();

          tx.delete(ref);

          tx.set(
            mov,
            movimiento(
              'eliminar',
              reservaId,
              snap.data(),
              null,
              user
            )
          );
        });

      } else if (accion === 'modificar') {
        await db.runTransaction(async tx => {
          const snap = await tx.get(ref);

          if (!snap.exists) {
            throw Error(
              'Reserva desaparecida después de actualizar Google'
            );
          }

          const antes = snap.data();

          const mov = db
            .collection('movimientos')
            .doc();

          tx.update(ref, {
            ...cambios,

            googleInviteState: 'sent',

            modificadoPor: user.uid,
            modificadoPorEmail:
              user.email || '',

            updatedAt:
              admin.firestore.FieldValue.serverTimestamp()
          });

          tx.set(
            mov,
            movimiento(
              'modificar',
              reservaId,
              antes,
              {
                ...antes,
                ...cambios
              },
              user
            )
          );
        });

      } else {
        await ref.update({
          googleEventId: result.eventoId,

          googleInvitados: correos,

          googleInvitacionEnviada:
            admin.firestore.FieldValue.serverTimestamp(),

          googleInviteState: 'sent'
        });
      }

    } catch (e) {
      console.error(
        'Google confirmado pero Firestore falló:',
        accion,
        reservaId,
        e
      );

      return fail(
        res,
        503,
        'Google confirmó el cambio, pero falló Firestore. No repitas la operación: requiere revisión administrativa.'
      );
    }

    return res.json({
      ok: true,

      mensaje: {
        crear: 'Invitación enviada',
        actualizar: 'Destinatarios actualizados',
        modificar: 'Reserva e invitación actualizadas',
        cancelar:
          'Invitación cancelada y reserva eliminada'
      }[accion],

      eventoId: result.eventoId || null
    });

  } catch (e) {
    console.error('Calendar API:', e);

    return fail(
      res,
      400,
      e.message || 'Error al procesar la operación'
    );
  }
};
