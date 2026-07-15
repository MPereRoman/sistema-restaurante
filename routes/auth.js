const express = require('express');
const router = express.Router();
const db = require('../db');

// Autenticación (login/logout) + Setup inicial (crear primer admin)
// Relacionado con:
// - middleware/auth.js (requireAuth/requireRole)
// - views/login.ejs (form login)
// - views/setup.ejs (crear primer admin si no existen usuarios)
// - database.sql (tabla usuarios)

let bcrypt;
function getBcrypt() {
  // bcryptjs (sin binarios) para facilitar despliegue en Windows / pkg
  // Si no está instalado, damos un error claro.
  if (!bcrypt) {
    try {
      bcrypt = require('bcryptjs');
    } catch (e) {
      bcrypt = null;
    }
  }
  return bcrypt;
}

async function countUsuarios() {
  const [rows] = await db.query('SELECT COUNT(*) AS cnt FROM usuarios');
  return Number(rows?.[0]?.cnt || 0);
}

function defaultRedirectForRole(rol) {
  const r = String(rol || '').toLowerCase();
  if (['cocinero', 'barman'].includes(r)) return '/cocina';
  if (r === 'mesero') return '/mesas';
  return '/ventas';
}

// GET /login
router.get('/login', async (req, res) => {
  try {
    // Si ya está logueado, redirigir según rol
    if (req.session?.user) return res.redirect(defaultRedirectForRole(req.session.user.rol));

    // Si no hay usuarios aún, guiar a setup
    let total = 0;
    try {
      total = await countUsuarios();
    } catch (_) {
      // Si la tabla aún no existe, también vamos a setup para mostrar instrucción
      total = 0;
    }

    if (total === 0) return res.redirect('/setup');

    res.render('login', { error: null });
  } catch (e) {
    res.render('login', { error: 'No se pudo cargar el login.' });
  }
});

// POST /login
router.post('/login', async (req, res) => {
  const usuario = String(req.body?.usuario || '').trim();
  const password = String(req.body?.password || '');

  if (!usuario || !password) return res.status(400).render('login', { error: 'Usuario y contraseña son requeridos.' });

  const bc = getBcrypt();
  if (!bc) return res.status(500).render('login', { error: 'Falta dependencia bcryptjs. Instala con: npm i bcryptjs' });

  try {
    const [rows] = await db.query(
      'SELECT id, usuario, nombre, password_hash, rol, activo FROM usuarios WHERE usuario = ? LIMIT 1',
      [usuario]
    );
    const u = rows?.[0];
    if (!u || Number(u.activo) !== 1) return res.status(401).render('login', { error: 'Usuario o contraseña incorrectos.' });

    const ok = await bc.compare(password, String(u.password_hash || ''));
    if (!ok) return res.status(401).render('login', { error: 'Usuario o contraseña incorrectos.' });

    // Guardar sesión
    req.session.user = {
      id: u.id,
      usuario: u.usuario,
      nombre: u.nombre || '',
      rol: u.rol
    };

    // last_login
    try {
      await db.query('UPDATE usuarios SET last_login = NOW() WHERE id = ?', [u.id]);
    } catch (_) {}

    res.redirect(defaultRedirectForRole(u.rol));
  } catch (e) {
    console.error('Error login:', e);
    // Si la tabla no existe aún, guiar a migración
    if (e && e.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).render('login', { error: 'Falta migración: cree la tabla usuarios (ver database.sql).' });
    }
    res.status(500).render('login', { error: 'Error interno al iniciar sesión.' });
  }
});

// POST /logout
router.post('/logout', (req, res) => {
  try {
    req.session.destroy(() => {
      res.redirect('/login');
    });
  } catch (_) {
    res.redirect('/login');
  }
});

// GET /setup - solo disponible si NO existen usuarios
router.get('/setup', async (req, res) => {
  try {
    // Si ya hay usuarios, no mostramos setup
    const total = await countUsuarios();
    if (total > 0) return res.redirect('/login');
    res.render('setup', { error: null });
  } catch (e) {
    // Si falla por falta de tabla, mostramos instrucción igual
    res.render('setup', { error: null });
  }
});

// POST /setup - crea el primer admin
router.post('/setup', async (req, res) => {
  const usuario = String(req.body?.usuario || '').trim();
  const nombre = String(req.body?.nombre || '').trim();
  const password = String(req.body?.password || '');
  const password2 = String(req.body?.password2 || '');

  if (!usuario || !password) return res.status(400).render('setup', { error: 'Usuario y contraseña son requeridos.' });
  if (password !== password2) return res.status(400).render('setup', { error: 'Las contraseñas no coinciden.' });

  const bc = getBcrypt();
  if (!bc) return res.status(500).render('setup', { error: 'Falta dependencia bcryptjs. Instala con: npm i bcryptjs' });

  try {
    const total = await countUsuarios();
    if (total > 0) return res.redirect('/login');

    const hash = await bc.hash(password, 10);
    await db.query(
      'INSERT INTO usuarios (usuario, nombre, password_hash, rol, activo) VALUES (?, ?, ?, ?, 1)',
      [usuario, nombre || null, hash, 'administrador']
    );

    res.redirect('/login');
  } catch (e) {
    console.error('Error setup:', e);
    if (e && e.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).render('setup', { error: 'Falta migración: cree la tabla usuarios (ver database.sql).' });
    }
    if (e && e.code === 'ER_DUP_ENTRY') {
      return res.status(400).render('setup', { error: 'Ya existe un usuario con ese nombre.' });
    }
    res.status(500).render('setup', { error: 'Error interno creando el usuario administrador.' });
  }
});

module.exports = router;

