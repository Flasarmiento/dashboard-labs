
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
  res.status(status).json({
    ok: false,
    error
  });

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return fail(res, 405, 'Método no permitido');
  }

  const authorization =
    req.headers.authorization || '';

  if (!authorization.startsWith('Bearer ')) {
    return fail(res, 401, 'Sin autenticación');
  }

  let user;

  try {
    user = await admin.auth().verifyIdToken(
      authorization.slice(7),
      true
    );
  } catch {
    return fail(res, 401, 'Sesión inválida');
  }

  try {
    const { accion, uid } = req.body || {};

    // Verificar si la cuenta tiene permitido el acceso.
    if (accion === 'estado') {
      const email = (user.email || '')
        .trim()
        .toLowerCase();

      const bloqueado = email
        ? await db
            .collection('usuariosBloqueados')
            .doc(email)
            .get()
        : null;

      if (bloqueado?.exists) {
        return fail(
          res,
          403,
          'Esta cuenta fue dada de baja. Consultá a coordinación.'
        );
      }

      const perfil = await db
        .collection('usuarios')
        .doc(user.uid)
        .get();

      if (
        perfil.exists &&
        perfil.data().activo === false
      ) {
        return fail(
          res,
          403,
          'Tu acceso está desactivado.'
        );
      }

      return res.json({
        ok: true
      });
    }

    // Solo administradores pueden gestionar usuarios.
    const perfil = await db
      .collection('usuarios')
      .doc(user.uid)
      .get();

    if (
      !perfil.exists ||
      perfil.data().rol !== 'admin' ||
      perfil.data().activo === false
    ) {
      return fail(
        res,
        403,
        'Solo administradores activos'
      );
    }

    if (
      ![
        'desactivar',
        'reactivar',
        'eliminar'
      ].includes(accion)
    ) {
      return fail(
        res,
        400,
        'Acción inválida'
      );
    }

    // Validar usuario de destino.
    if (
      typeof uid !== 'string' ||
      !/^[\w-]{1,200}$/.test(uid) ||
      uid === user.uid
    ) {
      return fail(
        res,
        400,
        'Usuario inválido o cuenta propia'
      );
    }

    const ref = db
      .collection('usuarios')
      .doc(uid);

    const doc = await ref.get();

    if (!doc.exists) {
      return fail(
        res,
        404,
        'Usuario no encontrado'
      );
    }

    const email = String(
      doc.data().email || ''
    ).trim().toLowerCase();

    // DESACTIVAR
    if (accion === 'desactivar') {
      await admin.auth().updateUser(uid, {
        disabled: true
      });

      await admin.auth().revokeRefreshTokens(uid);

      await ref.update({
        activo: false,
        desactivadoEn:
          admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // REACTIVAR
    else if (accion === 'reactivar') {
      await admin.auth().updateUser(uid, {
        disabled: false
      });

      await ref.update({
        activo: true
      });
    }

    // ELIMINAR
    else if (accion === 'eliminar') {
      if (!email || !email.includes('@')) {
        throw Error(
          'No se puede dar de baja una cuenta sin correo válido'
        );
      }

      // Registrar el correo para impedir su alta automática.
      await db
        .collection('usuariosBloqueados')
        .doc(email)
        .set({
          email,
          uid,
          fecha:
            admin.firestore.FieldValue.serverTimestamp(),
          por: user.uid
        });

      // Eliminar la cuenta de Firebase Authentication.
      try {
        await admin.auth().deleteUser(uid);
      } catch (e) {
        if (e.code !== 'auth/user-not-found') {
          throw e;
        }
      }

      // Eliminar el perfil de la colección usuarios.
      await ref.delete();
    }

    return res.json({
      ok: true,
      mensaje: 'Operación realizada'
    });

  } catch (e) {
    console.error('Usuarios API:', e);

    return fail(
      res,
      500,
      e.message || 'Error en gestión de usuarios'
    );
  }
};
