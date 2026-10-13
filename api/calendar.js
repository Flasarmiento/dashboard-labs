
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

  try {
    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Falta autenticación" });
    }

    const token = authorization.slice(7);
    const usuario = await admin.auth().verifyIdToken(token, true);

    const perfil = await admin
      .firestore()
      .collection("usuarios")
      .doc(usuario.uid)
      .get();

    if (!perfil.exists || perfil.data().rol !== "admin") {
      return res.status(403).json({
        error: "Solo los administradores pueden gestionar invitaciones"
      });
    }

    return res.status(200).json({
      ok: true,
      mensaje: "Administrador verificado correctamente"
    });

  } catch (error) {
    console.error("Error de autenticación:", error.message);
    return res.status(401).json({
      error: "No se pudo verificar la autorización"
    });
  }
};
