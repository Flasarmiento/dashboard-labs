
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n")
    })
  });
}

const db = admin.firestore();

function responder(res, codigo, datos) {
  return res.status(codigo).json(datos);
}

function obtenerFecha(valor) {
  if (typeof valor === "string") {
    const fecha = valor.match(/^\d{4}-\d{2}-\d{2}/);
    if (fecha) return fecha[0];
  }
  if (valor && typeof valor.toDate === "function") {
    const d = valor.toDate();
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(d);
  }
  throw new Error("No se pudo interpretar la fecha de la reserva");
}

function obtenerHora(valor, minutos) {
  if (typeof valor === "number" && Number.isInteger(valor)) {
    return `${String(valor).padStart(2, "0")}:${String(minutos || 0).padStart(2, "0")}`;
  }

  if (typeof valor === "string") {
    if (/^\d{1,2}:\d{2}$/.test(valor)) return valor;
    if (/^\d{1,2}$/.test(valor)) {
      return `${valor.padStart(2, "0")}:${String(minutos || 0).padStart(2, "0")}`;
    }
  }

  throw new Error("No se pudo interpretar el horario de la reserva");
}

function datosEvento(reserva) {
  const fecha = obtenerFecha(reserva.fecha);

  const horaInicio = obtenerHora(
    reserva.sh ?? reserva.horaInicio ?? reserva.inicio,
    reserva.sm
  );

  const horaFin = obtenerHora(
    reserva.eh ?? reserva.horaFin ?? reserva.fin,
    reserva.em
  );

  const inicio = `${fecha}T${horaInicio}:00-03:00`;
  const fin = `${fecha}T${horaFin}:00-03:00`;

  if (
    !Number.isFinite(Date.parse(inicio)) ||
    !Number.isFinite(Date.parse(fin)) ||
    Date.parse(fin) <= Date.parse(inicio)
  ) {
    throw new Error("La reserva tiene fechas u horarios inválidos");
  }

  return {
    titulo: String(reserva.titulo || "Reserva de laboratorio"),
    inicio,
    fin,
    ubicacion: String(reserva.lab || reserva.laboratorio || ""),
    descripcion: "Reserva realizada desde el sistema de laboratorios."
  };
}

async function llamarAppsScript(datos) {
  const url = process.env.APPS_SCRIPT_URL;
  const secret = process.env.APPS_SCRIPT_SECRET;

  if (!url || !secret) {
    throw new Error("Falta configurar Google Apps Script");
  }

  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
    throw new Error("URL de Apps Script inválida");
  }

  const respuesta = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=utf-8"
    },
    body: JSON.stringify({
      ...datos,
      secret
    }),
    redirect: "follow",
    signal: AbortSignal.timeout(25000)
  });

  if (!respuesta.ok) {
    throw new Error("Google Apps Script no respondió correctamente");
  }

  let resultado;

  try {
    resultado = JSON.parse(await respuesta.text());
  } catch (_) {
    throw new Error("Google Apps Script no devolvió JSON");
  }

  if (resultado.ok !== true) {
    throw new Error(resultado.error || "Google rechazó la operación");
  }

  return resultado;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return responder(res, 405, {
      error: "Método no permitido"
    });
  }

  const authorization = req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    return responder(res, 401, {
      error: "Falta autenticación"
    });
  }

  let usuario;

  try {
    usuario = await admin.auth().verifyIdToken(
      authorization.slice(7),
      true
    );
  } catch (_) {
    return responder(res, 401, {
      error: "Sesión inválida o vencida"
    });
  }

  try {
    const perfil = await db.collection("usuarios")
      .doc(usuario.uid)
      .get();

    if (!perfil.exists || perfil.data().rol !== "admin") {
      return responder(res, 403, {
        error: "Solo los administradores pueden enviar invitaciones"
      });
    }

    const { accion = "prueba", reservaId, invitados } = req.body || {};

    if (accion === "prueba") {
      const resultado = await llamarAppsScript({
        accion: "prueba"
      });

      return responder(res, 200, {
        ok: true,
        mensaje: resultado.mensaje || "Conexión correcta"
      });
    }

    if (accion !== "crear") {
      return responder(res, 400, {
        error: "Acción no habilitada todavía"
      });
    }

    if (typeof reservaId !== "string" || !reservaId.trim()) {
      return responder(res, 400, {
        error: "Falta identificar la reserva"
      });
    }

    if (
      !Array.isArray(invitados) ||
      invitados.length === 0 ||
      invitados.length > 50
    ) {
      return responder(res, 400, {
        error: "Seleccioná entre 1 y 50 destinatarios"
      });
    }

    const correos = [
      ...new Set(
        invitados.map(x => String(x).trim().toLowerCase())
      )
    ];

    if (correos.some(x => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))) {
      return responder(res, 400, {
        error: "Hay correos electrónicos inválidos"
      });
    }

    const referencia = db.collection("reservas").doc(reservaId);
    const reservaDoc = await referencia.get();

    if (!reservaDoc.exists) {
      return responder(res, 404, {
        error: "La reserva no existe"
      });
    }

    const reserva = reservaDoc.data();

    if (reserva.googleEventId) {
      return responder(res, 409, {
        error: "Esta reserva ya tiene una invitación de Google Calendar"
      });
    }

    const evento = datosEvento(reserva);

    // Bloqueo temporal para impedir envíos simultáneos.
    const bloqueoId = `${usuario.uid}-${Date.now()}`;
    const ahora = Date.now();

    await db.runTransaction(async tx => {
      const actual = await tx.get(referencia);

      if (!actual.exists) {
        throw new Error("La reserva ya no existe");
      }

      const datos = actual.data();

      if (datos.googleEventId) {
        throw new Error("La invitación ya fue enviada");
      }

      if (
        datos.googleInviteLock &&
        datos.googleInviteLock.expiresAt > ahora
      ) {
        throw new Error("Ya hay un envío en proceso");
      }

      tx.update(referencia, {
        googleInviteLock: {
          id: bloqueoId,
          expiresAt: ahora + 120000
        }
      });
    });

    try {
      const resultado = await llamarAppsScript({
        accion: "crear",
        ...evento,
        invitados: correos
      });

      if (!resultado.eventoId) {
        throw new Error("Google no devolvió el identificador del evento");
      }

      await referencia.update({
        googleEventId: resultado.eventoId,
        googleInvitados: correos,
        googleInvitacionEnviada: admin.firestore.FieldValue.serverTimestamp(),
        googleInviteLock: admin.firestore.FieldValue.delete()
      });

      return responder(res, 200, {
        ok: true,
        mensaje: "Invitación enviada correctamente",
        eventoId: resultado.eventoId
      });

    } catch (error) {
      // Si Google creó el evento pero falló la respuesta,
      // no reintentar automáticamente: podría duplicarlo.
      console.error("Error de invitación:", error.message);

      return responder(res, 502, {
        error: error.message,
        advertencia: "Verificá Google Calendar antes de intentar nuevamente."
      });
    }

  } catch (error) {
    console.error("Error de Calendar:", error.message);

    return responder(res, 400, {
      error: error.message || "No se pudo procesar la solicitud"
    });
  }
};
