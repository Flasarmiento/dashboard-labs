
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

const validEmail = x =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);

// Convierte una reserva de Firestore a un evento de Google Calendar.
function toEvent(r) {
  if (
    typeof r.fecha !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(r.fecha)
  ) {
    throw Error('Fecha de reserva inválida');
  }

  function hora(o) {
    if (
      !o ||
      !Number.isInteger(o.hour) ||
      !Number.isInteger(o.minute) ||
      o.hour < 0 ||
      o.hour > 23 ||
      o.minute < 0 ||
      o.minute > 59
    ) {
      throw Error('Horario de reserva inválido');
    }

    return `${String(o.hour).padStart(2, '0')}:${String(o.minute).padStart(2, '0')}`;
  }

  const inicio = `${r.fecha}T${hora(r.inicio)}:00-03:00`;
  const fin = `${r.fecha}T${hora(r.fin)}:00-03:00`;

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

// Comunicación segura con Google Apps Script.
async function script(payload) {
  const url = process.env.APPS_SCRIPT_URL;
  const secret = process.env.APPS_SCRIPT_SECRET;

  if (
    !url ||
    !secret ||
    !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)
  ) {
    throw Error('Configuración de Apps Script inválida');
  }

  const response = await fetch(url, {
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

  if (!response.ok) {
    throw Error(
      'Google Apps Script no respondió correctamente'
    );
  }

  let result;

  try {
    result = JSON.parse(await response.text());
  } catch {
    throw Error('Apps Script no devolvió JSON');
  }

  if (result.ok !== true) {
    throw Error(
      result.error || 'Apps Script rechazó la operación'
    );
  }

  return result;
}

// API principal.
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
    return fail(
      res,
      401,
      'Sesión inválida o vencida'
    );
  }

  try {
    // Verificar que sea administrador.
    const profile = await db
      .collection('usuarios')
      .doc(user.uid)
      .get();

    if (
      !profile.exists ||
      profile.data().rol !== 'admin'
    ) {
      return fail(
        res,
        403,
        'Solo administradores'
      );
    }

    const {
      accion = 'prueba',
      reservaId,
      invitados
    } = req.body || {};

    // Prueba de conexión.
    if (accion === 'prueba') {
      await script({ accion: 'prueba' });

      return res.status(200).json({
        ok: true,
        mensaje:
          'Conexión segura con Google Apps Script correcta'
      });
    }

    // Acciones habilitadas.
    if (!['crear', 'actualizar'].includes(accion)) {
      return fail(
        res,
        400,
        'Acción todavía no habilitada'
      );
    }

    // Validar ID de reserva.
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

    // Validar destinatarios.
    if (
      !Array.isArray(invitados) ||
      invitados.length < 1 ||
      invitados.length > 50 ||
      invitados.some(x => typeof x !== 'string')
    ) {
      return fail(
        res,
        400,
        'Destinatarios inválidos'
      );
    }

    const emails = [
      ...new Set(
        invitados.map(x =>
          x.trim().toLowerCase()
        )
      )
    ];

    if (emails.some(x => !validEmail(x))) {
      return fail(
        res,
        400,
        'Hay correos inválidos'
      );
    }

    // Consultar la reserva real.
    const ref = db
      .collection('reservas')
      .doc(reservaId);

    const lock =
      admin.firestore.FieldValue.serverTimestamp();

    let evento;

    // Bloquear envíos simultáneos y evitar duplicados.
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);

      if (!snap.exists) {
        throw Error('La reserva no existe');
      }

      const r = snap.data();

      if (accion === 'crear' && r.googleEventId) {
        throw Error(
          'Esta reserva ya tiene una invitación'
        );
      }

      if (accion === 'actualizar' && !r.googleEventId) {
        throw Error(
          'Esta reserva no tiene invitación para actualizar'
        );
      }

      if (
        accion === 'actualizar' &&
        r.googleInviteState !== 'sent'
      ) {
        throw Error(
          'El evento requiere verificación antes de actualizar'
        );
      }

      if (r.googleInviteState === 'pending') {
        throw Error(
          'Envío pendiente de verificación en Google Calendar'
        );
      }

      evento = toEvent(r);

      // Si existe, utilizar el mismo evento de Google.
      if (accion === 'actualizar') {
        evento.eventoId = r.googleEventId;
      }

      tx.update(ref, {
        googleInviteState: 'pending',
        googleInviteStartedAt: lock,
        googleInviteStartedBy: user.uid
      });
    });

    let result;

    // Crear o actualizar en Google Calendar.
    try {
      result = await script({
        accion,
        ...evento,
        invitados: emails
      });
    } catch (e) {
      console.error(
        'Envío incierto de reserva',
        reservaId,
        e
      );

      return fail(
        res,
        502,
        'No se pudo confirmar el envío. Revisá Google Calendar; no vuelvas a enviarlo automáticamente.'
      );
    }

    if (!result.eventoId) {
      return fail(
        res,
        502,
        'Google no devolvió el ID del evento. Revisá Calendar antes de reintentar.'
      );
    }

    // Guardar resultado en Firestore.
    try {
      await ref.update({
        googleEventId: result.eventoId,

        googleInvitados: emails,

        googleInvitacionEnviada:
          admin.firestore.FieldValue.serverTimestamp(),

        googleInviteState: 'sent'
      });
    } catch (e) {
      console.error(
        'Evento procesado, no se guardó el resultado',
        reservaId,
        result.eventoId,
        e
      );

      return fail(
        res,
        503,
        'Google procesó la invitación pero no se pudo registrar. Contactá al administrador antes de reintentar.'
      );
    }

    return res.status(200).json({
      ok: true,

      mensaje:
        accion === 'crear'
          ? 'Invitación enviada correctamente'
          : 'Invitación actualizada correctamente',

      eventoId: result.eventoId
    });

  } catch (e) {
    console.error('Calendar API:', e);

    return fail(
      res,
      400,
      e.message || 'Error al procesar la invitación'
    );
  }
};
