
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

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  const authorization = req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Falta autenticación" });
  }

  let usuario;

  try {
    usuario = await admin.auth().verifyIdToken(
      authorization.slice(7),
      true
    );
  } catch (error) {
    console.error("Token inválido:", error.message);
    return res.status(401).json({
      error: "Sesión inválida o vencida"
    });
  }

  try {
    const perfil = await admin.firestore()
      .collection("usuarios")
      .doc(usuario.uid)
      .get();

    if (!perfil.exists || perfil.data().rol !== "admin") {
      return res.status(403).json({
        error: "Solo los administradores pueden gestionar invitaciones"
      });
    }
  } catch (error) {
    console.error("Error al verificar rol:", error.message);
    return res.status(503).json({
      error: "No se pudo verificar el rol de administrador"
    });
  }

  const url = process.env.APPS_SCRIPT_URL;
  const secret = process.env.APPS_SCRIPT_SECRET;

  if (!url || !secret) {
    return res.status(503).json({
      error: "Falta configurar Apps Script en Vercel"
    });
  }

  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
    return res.status(503).json({
      error: "URL de Apps Script inválida"
    });
  }

  try {
    const respuesta = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify({
        secret,
        accion: "prueba"
      }),
      redirect: "follow",
      signal: AbortSignal.timeout(15000)
    });

    if (!respuesta.ok) {
      console.error("Apps Script HTTP:", respuesta.status);
      return res.status(502).json({
        error: "Apps Script no respondió correctamente"
      });
    }

    const texto = await respuesta.text();
    let resultado;

    try {
      resultado = JSON.parse(texto);
    } catch (_) {
      return res.status(502).json({
        error: "Apps Script no devolvió JSON. Revisá la implementación web."
      });
    }

    if (resultado.ok !== true) {
      return res.status(502).json({
        error: resultado.error || "Apps Script rechazó la solicitud"
      });
    }

    return res.status(200).json({
      ok: true,
      mensaje: "Conexión segura con Google Apps Script correcta"
    });

  } catch (error) {
    console.error("Error de conexión Apps Script:", error.message);
    return res.status(502).json({
      error: "No se pudo conectar con Google Apps Script"
    });
  }
};
