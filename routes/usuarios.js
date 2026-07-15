const express = require('express');
const router = express.Router();
const db = require('../db');

// CRUD de usuarios (solo administrador; protección se aplica en server.js con requireRole('administrador'))
// Relacionado con:
// - views/usuarios.ejs (panel)
// - public/js/usuarios.js (acciones fetch)
// - database.sql (tabla usuarios)

let bcrypt;
function getBcrypt() {
  if (!bcrypt) {
    try { bcrypt = require('bcryptjs'); } catch (e) { bcrypt = null; }
  }
  return bcrypt;
}

const ROLES = ['administrador', 'mesero', 'cocinero', 'barman'];

async function countAdminsExcept(userIdToExclude = null) {
  const params = [];
  let where = `WHERE rol = 'administrador' AND activo = 1`;
  if (userIdToExclude != null) {
    where += ' AND id <> ?';
    params.push(userIdToExclude);
  }
  const [rows] = await db.query(`SELECT COUNT(*) AS cnt FROM usuarios ${where}`, params);
  return Number(rows?.[0]?.cnt || 0);
}

// GET /usuarios - render panel
router.get('/', async (req, res) => {
  try {
    const [usuarios] = await db.query(
      'SELECT id, usuario, nombre, rol, activo, last_login, created_at FROM usuarios ORDER BY created_at DESC, id DESC'
    );
    res.render('usuarios', { usuarios: usuarios || [], roles: ROLES });
  } catch (e) {
    console.error('Error usuarios panel:', e);
    if (e && e.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).render('error', {
        error: { message: 'Falta migración: cree la tabla usuarios (ver database.sql)', stack: '' }
      });
    }
    res.status(500).render('error', { error: { message: 'No se pudo cargar el panel de usuarios', stack: '' } });
  }
});

// GET /usuarios/listar - API listar
router.get('/listar', async (req, res) => {
  try {
    const [usuarios] = await db.query(
      'SELECT id, usuario, nombre, rol, activo, last_login, created_at FROM usuarios ORDER BY created_at DESC, id DESC'
    );
    res.json(usuarios || []);
  } catch (e) {
    console.error('Error listar usuarios:', e);
    res.status(500).json({ error: 'Error al listar usuarios' });
  }
});

// POST /usuarios - crear usuario
router.post('/', async (req, res) => {
  const usuario = String(req.body?.usuario || '').trim();
  const nombre = String(req.body?.nombre || '').trim();
  const rol = String(req.body?.rol || '').trim().toLowerCase();
  const activo = Number(req.body?.activo ?? 1) ? 1 : 0;
  const password = String(req.body?.password || '');

  if (!usuario) return res.status(400).json({ error: 'usuario requerido' });
  if (!password) return res.status(400).json({ error: 'password requerido' });
  if (!ROLES.includes(rol)) return res.status(400).json({ error: 'rol inválido' });

  const bc = getBcrypt();
  if (!bc) return res.status(500).json({ error: 'Falta dependencia bcryptjs (npm i bcryptjs)' });

  try {
    const hash = await bc.hash(password, 10);
    const [result] = await db.query(
      'INSERT INTO usuarios (usuario, nombre, password_hash, rol, activo) VALUES (?, ?, ?, ?, ?)',
      [usuario, nombre || null, hash, rol, activo]
    );
    res.status(201).json({ id: result.insertId });
  } catch (e) {
    console.error('Error crear usuario:', e);
    if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ese usuario ya existe' });
    res.status(500).json({ error: 'Error al crear usuario' });
  }
});

// PUT /usuarios/:id - actualizar datos (sin password)
router.put('/:id(\\d+)', async (req, res) => {
  const id = Number(req.params.id);
  const usuario = String(req.body?.usuario || '').trim();
  const nombre = String(req.body?.nombre || '').trim();
  const rol = String(req.body?.rol || '').trim().toLowerCase();
  const activo = Number(req.body?.activo ?? 1) ? 1 : 0;

  if (!usuario) return res.status(400).json({ error: 'usuario requerido' });
  if (!ROLES.includes(rol)) return res.status(400).json({ error: 'rol inválido' });

  try {
    // No permitir dejar el sistema sin admin activo
    const [rows] = await db.query('SELECT id, rol, activo FROM usuarios WHERE id = ? LIMIT 1', [id]);
    const current = rows?.[0];
    if (!current) return res.status(404).json({ error: 'Usuario no encontrado' });

    const wasAdminActive = String(current.rol) === 'administrador' && Number(current.activo) === 1;
    const willBeAdminActive = rol === 'administrador' && activo === 1;
    if (wasAdminActive && !willBeAdminActive) {
      const others = await countAdminsExcept(id);
      if (others === 0) return res.status(400).json({ error: 'Debe existir al menos un administrador activo' });
    }

    await db.query(
      'UPDATE usuarios SET usuario = ?, nombre = ?, rol = ?, activo = ? WHERE id = ?',
      [usuario, nombre || null, rol, activo, id]
    );
    res.json({ message: 'Usuario actualizado' });
  } catch (e) {
    console.error('Error actualizar usuario:', e);
    if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ese usuario ya existe' });
    res.status(500).json({ error: 'Error al actualizar usuario' });
  }
});

// PUT /usuarios/:id/password - cambiar contraseña
router.put('/:id(\\d+)/password', async (req, res) => {
  const id = Number(req.params.id);
  const password = String(req.body?.password || '');
  if (!password) return res.status(400).json({ error: 'password requerido' });

  const bc = getBcrypt();
  if (!bc) return res.status(500).json({ error: 'Falta dependencia bcryptjs (npm i bcryptjs)' });

  try {
    const hash = await bc.hash(password, 10);
    const [result] = await db.query('UPDATE usuarios SET password_hash = ? WHERE id = ?', [hash, id]);
    if ((result?.affectedRows || 0) === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ message: 'Contraseña actualizada' });
  } catch (e) {
    console.error('Error cambiar password:', e);
    res.status(500).json({ error: 'Error al cambiar contraseña' });
  }
});

// DELETE /usuarios/:id - eliminar usuario
router.delete('/:id(\\d+)', async (req, res) => {
  const id = Number(req.params.id);
  const currentUserId = Number(req.session?.user?.id || 0);
  if (id === currentUserId) return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });

  try {
    const [rows] = await db.query('SELECT id, rol, activo FROM usuarios WHERE id = ? LIMIT 1', [id]);
    const u = rows?.[0];
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });

    const isAdminActive = String(u.rol) === 'administrador' && Number(u.activo) === 1;
    if (isAdminActive) {
      const others = await countAdminsExcept(id);
      if (others === 0) return res.status(400).json({ error: 'No puedes eliminar el último administrador activo' });
    }

    const [result] = await db.query('DELETE FROM usuarios WHERE id = ?', [id]);
    if ((result?.affectedRows || 0) === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ message: 'Usuario eliminado' });
  } catch (e) {
    console.error('Error eliminar usuario:', e);
    res.status(500).json({ error: 'Error al eliminar usuario' });
  }
});

module.exports = router;

