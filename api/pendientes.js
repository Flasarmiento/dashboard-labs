// =====================================================================
//  /api/pendientes — Avisos por email de Pendientes (Centro de Simulación)
//  - POST (con sesión):  notificar | responder | resuelto
//  - GET  (Vercel Cron): recordatorio diario de pendientes que vencen hoy
//  Envía los correos a través de un Google Apps Script propio de mails
//  (variables MAIL_SCRIPT_URL y MAIL_SCRIPT_SECRET). No toca reservas.
// =====================================================================
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
const SITIO = process.env.SITIO_URL || 'https://dashboard-labs.vercel.app/';
const ORG = 'COE';
const REMITENTE = 'Centro de Simulación';
const ZONA = 'America/Argentina/Buenos_Aires';

const fail = (res, status, error) => res.status(status).json({ ok: false, error });
const emailOK = s => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const hoyAR = () => new Date().toLocaleDateString('en-CA', { timeZone: ZONA });
const fFecha = k => /^\d{4}-\d{2}-\d{2}$/.test(k || '') ? k.split('-').reverse().join('/') : '';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const corto = (s, n = 70) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function nombreDe(p, email) {
  const d = (p.destinatariosInfo || []).find(x => x && x.email === email);
  return (d && d.nombre && d.nombre !== email) ? d.nombre : '';
}

// ---------- Envío por Google Apps Script ----------
async function enviar(mensajes) {
  const url = process.env.MAIL_SCRIPT_URL;
  const secret = process.env.MAIL_SCRIPT_SECRET;
  if (!url || !secret || !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
    throw Error('El envío de emails no está configurado (faltan MAIL_SCRIPT_URL / MAIL_SCRIPT_SECRET en Vercel).');
  }
  const validos = mensajes.filter(m => emailOK(m.para));
  if (!validos.length) return { enviados: 0, errores: [] };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ accion: 'email', secret, mensajes: validos }),
    redirect: 'follow',
    signal: AbortSignal.timeout(25000)
  });
  if (!r.ok) throw Error('El servicio de emails de Google no respondió correctamente');
  let out;
  try { out = JSON.parse(await r.text()); } catch { throw Error('El servicio de emails no devolvió una respuesta válida'); }
  if (out.ok !== true) throw Error(out.error || 'Google rechazó el envío');
  return { enviados: out.enviados || 0, errores: out.errores || [] };
}

// ---------- Plantilla de email ----------
function plantilla({ saludo, intro, p, extraTitulo, extraTexto, boton }) {
  const filas = [];
  if (p.vence) filas.push(['Vence', fFecha(p.vence)]);
  if (p.laboratorio) filas.push(['Espacio', p.laboratorio]);
  if (p.creadoPorNombre || p.creadoPorEmail) filas.push(['Asignado por', p.creadoPorNombre || p.creadoPorEmail]);
  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;color:#173449;max-width:560px;margin:0 auto">
  <div style="background:#173449;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;font-size:16px;font-weight:bold">📌 ${esc(REMITENTE)}</div>
  <div style="border:1px solid #d9e4ea;border-top:0;border-radius:0 0 10px 10px;padding:18px">
    <p style="margin:0 0 10px">${esc(saludo)}</p>
    <p style="margin:0 0 12px">${esc(intro)}</p>
    <div style="background:#fff8e1;border-left:4px solid #e08a00;padding:10px 12px;border-radius:6px;white-space:pre-wrap;font-size:15px">${esc(p.texto)}</div>
    ${filas.length ? `<table style="margin:12px 0;font-size:14px;border-collapse:collapse">${filas.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#56707f">${esc(k)}</td><td style="padding:2px 0;font-weight:bold">${esc(v)}</td></tr>`).join('')}</table>` : ''}
    ${extraTexto ? `<p style="margin:14px 0 4px;font-weight:bold">${esc(extraTitulo)}</p><div style="background:#eef7f1;border-left:4px solid #2e7d32;padding:10px 12px;border-radius:6px;white-space:pre-wrap">${esc(extraTexto)}</div>` : ''}
    <p style="margin:18px 0 6px"><a href="${esc(SITIO)}" style="display:inline-block;background:#21855c;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:bold">${esc(boton)}</a></p>
    <p style="margin:6px 0 0;font-size:12px;color:#7a8c97">Ingresá a ${esc(SITIO)} y abrí el botón 📌 Pendientes.</p>
  </div>
</div>`;
  const texto = [saludo, '', intro, '', p.texto, '',
    ...filas.map(([k, v]) => `${k}: ${v}`),
    ...(extraTexto ? ['', extraTitulo, extraTexto] : []),
    '', `${boton}: ${SITIO}`].join('\n');
  return { html, texto };
}

function mensajeAsignacion(p, email, recordatorio = false) {
  const nombre = nombreDe(p, email);
  const saludo = nombre ? `Hola ${nombre},` : 'Hola,';
  const intro = recordatorio
    ? `Te recordamos que hoy vence un pendiente activo con el ${ORG}:`
    : `Tenés un pendiente activo con el ${ORG}:`;
  const { html, texto } = plantilla({ saludo, intro, p, boton: 'Ingresá para resolverlo' });
  return {
    para: email,
    asunto: recordatorio ? `Recordatorio: hoy vence un pendiente con el ${ORG}` : `Tenés un pendiente activo con el ${ORG}: ${corto(p.texto, 60)}`,
    html, texto, nombre: REMITENTE,
    responderA: emailOK(p.creadoPorEmail) ? p.creadoPorEmail : ''
  };
}

// ---------- Permisos ----------
async function perfil(uid) {
  const s = await db.collection('usuarios').doc(uid).get();
  return s.exists ? s.data() : null;
}
const esAdmin = pf => !!pf && pf.rol === 'admin' && pf.activo !== false;

// ---------- Recordatorio diario (Vercel Cron) ----------
async function recordatorios(res) {
  const hoy = hoyAR();
  const snap = await db.collection('pendientes').where('vence', '==', hoy).get();
  let pendientes = 0, enviados = 0;
  const errores = [];
  for (const doc of snap.docs) {
    const p = doc.data();
    if (p.estado !== 'abierto' || p.recordatorioEnviado === hoy) continue;
    pendientes++;
    try {
      const r = await enviar((p.destinatarios || []).map(e => mensajeAsignacion(p, e, true)));
      enviados += r.enviados;
      if (r.errores.length) errores.push(...r.errores);
      await doc.ref.update({ recordatorioEnviado: hoy });
    } catch (e) {
      console.error('Recordatorio', doc.id, e);
      errores.push(doc.id + ': ' + e.message);
    }
  }
  return res.json({ ok: true, fecha: hoy, pendientes, enviados, errores });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Cron diario de Vercel (GET con CRON_SECRET)
  if (req.method === 'GET') {
    const secreto = process.env.CRON_SECRET;
    if (!secreto || (req.headers.authorization || '') !== `Bearer ${secreto}`) return fail(res, 401, 'No autorizado');
    try { return await recordatorios(res); }
    catch (e) { console.error('Cron pendientes:', e); return fail(res, 500, e.message); }
  }

  if (req.method !== 'POST') return fail(res, 405, 'Método no permitido');

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return fail(res, 401, 'Falta autenticación');
  let user;
  try { user = await admin.auth().verifyIdToken(auth.slice(7), true); }
  catch { return fail(res, 401, 'Sesión inválida'); }

  try {
    const { accion, pendienteId, correos, texto } = req.body || {};
    if (typeof pendienteId !== 'string' || !/^[\w-]{1,200}$/.test(pendienteId)) return fail(res, 400, 'Pendiente inválido');
    const ref = db.collection('pendientes').doc(pendienteId);
    const snap = await ref.get();
    if (!snap.exists) return fail(res, 404, 'El pendiente no existe');
    const p = snap.data();
    const pf = await perfil(user.uid);
    const admin_ = esAdmin(pf);
    const miEmail = String(user.email || '').toLowerCase();
    const soyDestinatario = user.email_verified === true && (p.destinatarios || []).includes(miEmail);
    const miNombre = String((pf && pf.nombre) || user.name || miEmail);

    // 1) Aviso al crear / al sumar destinatarios (solo admins)
    if (accion === 'notificar') {
      if (!admin_) return fail(res, 403, 'Solo administradores');
      if (p.estado !== 'abierto') return fail(res, 400, 'El pendiente ya está resuelto');
      let lista = p.destinatarios || [];
      if (Array.isArray(correos)) {
        const pedidos = correos.map(x => String(x).toLowerCase());
        lista = lista.filter(e => pedidos.includes(e));   // solo destinatarios reales del pendiente
      }
      if (!lista.length) return res.json({ ok: true, enviados: 0 });
      const r = await enviar(lista.map(e => mensajeAsignacion(p, e)));
      const ok = lista.filter(e => !r.errores.some(x => String(x).startsWith(e)));
      if (ok.length) await ref.update({
        avisoEnviadoA: admin.firestore.FieldValue.arrayUnion(...ok),
        avisoEnviadoAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.json({ ok: true, enviados: r.enviados, errores: r.errores });
    }

    // 2) Respuesta / descargo (destinatarios o admins) → se guarda y se avisa
    if (accion === 'responder') {
      if (!admin_ && !soyDestinatario) return fail(res, 403, 'No tenés acceso a este pendiente');
      const t = String(texto || '').trim();
      if (!t || t.length > 2000) return fail(res, 400, 'Escribí una respuesta (máximo 2000 caracteres)');
      if ((p.respuestas || []).length >= 200) return fail(res, 400, 'Este pendiente alcanzó el máximo de respuestas');
      const respuesta = {
        autorUid: user.uid, autorEmail: miEmail, autorNombre: miNombre, texto: t,
        fecha: admin.firestore.Timestamp.now()
      };
      await ref.update({
        respuestas: admin.firestore.FieldValue.arrayUnion(respuesta),
        ultimaRespuestaAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      // ¿A quién avisar? Si responde quien lo creó → a los destinatarios; si no → a quien lo creó.
      const esCreador = user.uid === p.creadoPor;
      const para = esCreador
        ? (p.destinatarios || []).filter(e => e !== miEmail)
        : (emailOK(p.creadoPorEmail) && p.creadoPorEmail !== miEmail ? [p.creadoPorEmail] : []);
      let aviso = { enviados: 0, errores: [] }, avisoError = '';
      try {
        aviso = await enviar(para.map(e => {
          const nombre = esCreador ? nombreDe(p, e) : (p.creadoPorNombre || '');
          const { html, texto: txt } = plantilla({
            saludo: nombre ? `Hola ${nombre},` : 'Hola,',
            intro: `${miNombre} respondió sobre este pendiente con el ${ORG}:`,
            p, extraTitulo: `Respuesta de ${miNombre}:`, extraTexto: t,
            boton: 'Ingresá para ver el pendiente'
          });
          return { para: e, asunto: `Respuesta de ${miNombre} a un pendiente: ${corto(p.texto, 50)}`, html, texto: txt, nombre: REMITENTE, responderA: miEmail };
        }));
      } catch (e) { console.error('Aviso de respuesta', pendienteId, e); avisoError = e.message; }
      return res.json({ ok: true, avisados: aviso.enviados, avisoError });
    }

    // 3) Aviso a quien lo creó cuando otra persona lo marca como resuelto
    if (accion === 'resuelto') {
      if (!admin_ && !soyDestinatario) return fail(res, 403, 'No tenés acceso a este pendiente');
      if (p.estado !== 'resuelto' || p.resueltoPor !== user.uid) return res.json({ ok: true, enviados: 0 });
      if (p.creadoPor === user.uid || !emailOK(p.creadoPorEmail)) return res.json({ ok: true, enviados: 0 });
      const { html, texto: txt } = plantilla({
        saludo: p.creadoPorNombre ? `Hola ${p.creadoPorNombre},` : 'Hola,',
        intro: `${miNombre} marcó como resuelto este pendiente con el ${ORG}:`,
        p, extraTitulo: 'Comentario:', extraTexto: p.notaResolucion || '',
        boton: 'Ingresá para verlo'
      });
      const r = await enviar([{ para: p.creadoPorEmail, asunto: `✓ Resuelto: ${corto(p.texto, 60)}`, html, texto: txt, nombre: REMITENTE, responderA: miEmail }]);
      return res.json({ ok: true, enviados: r.enviados });
    }

    return fail(res, 400, 'Acción desconocida');
  } catch (e) {
    console.error('Pendientes API:', e);
    return fail(res, 400, e.message || 'Error al procesar');
  }
};
