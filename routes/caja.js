const express = require('express');
const router = express.Router();
const db = require('../db');
const { createDailyCut, formatLocalDate, getDailySummary, isIsoDate } = require('../services/daily-summary');

const EXPENSE_METHODS = new Set(['efectivo', 'transferencia', 'tarjeta', 'otro']);

function parseNonNegativeMoney(value, fieldName) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) throw new Error(`${fieldName} debe ser un número mayor o igual a 0`);
    return Math.round(amount * 100) / 100;
}

function validateDate(value) {
    const fecha = String(value || '');
    if (!isIsoDate(fecha)) throw new Error('Fecha inválida');
    return fecha;
}

router.get('/gastos', (req, res) => {
    res.render('gastos', { fechaHoy: formatLocalDate() });
});

router.get('/api/gastos/resumen', async (req, res) => {
    try {
        const fecha = validateDate(req.query.fecha || formatLocalDate());
        res.json(await getDailySummary(fecha, db, { includeDetails: true }));
    } catch (error) {
        console.error('Error al obtener resumen de caja:', error);
        res.status(400).json({ error: error.message || 'No se pudo obtener el resumen' });
    }
});

router.get('/api/gastos/historico', async (req, res) => {
    try {
        const anio = Number(req.query.anio || new Date().getFullYear());
        if (!Number.isInteger(anio) || anio < 2000 || anio > 2200) {
            return res.status(400).json({ error: 'Año inválido' });
        }
        const [semanas] = await db.query(`
            SELECT semana_inicio, semana_fin, anio, numero_semana, neto
            FROM resumenes_semanales
            WHERE anio = ?
            ORDER BY semana_inicio DESC
        `, [anio]);
        const neto_anual = semanas.reduce((sum, semana) => sum + Number(semana.neto || 0), 0);
        res.json({ anio, semanas, neto_anual });
    } catch (error) {
        console.error('Error al consultar histórico semanal:', error);
        res.status(500).json({ error: 'No se pudo consultar el histórico semanal' });
    }
});

router.post('/api/gastos', async (req, res) => {
    try {
        const fecha = validateDate(req.body?.fecha || formatLocalDate());
        const concepto = String(req.body?.concepto || '').trim();
        const total = parseNonNegativeMoney(req.body?.total, 'El total');
        const metodoPago = String(req.body?.metodo_pago || 'efectivo').toLowerCase();
        if (!concepto) return res.status(400).json({ error: 'El concepto es requerido' });
        if (concepto.length > 200) return res.status(400).json({ error: 'El concepto no puede exceder 200 caracteres' });
        if (total <= 0) return res.status(400).json({ error: 'El total debe ser mayor a 0' });
        if (!EXPENSE_METHODS.has(metodoPago)) return res.status(400).json({ error: 'Método de pago inválido' });

        const user = req.session?.user || {};
        const [result] = await db.query(`
            INSERT INTO gastos (fecha, concepto, total, metodo_pago, creado_por_id, creado_por_nombre)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [
            fecha,
            concepto,
            total,
            metodoPago,
            Number(user.id) || null,
            String(user.nombre || user.usuario || '').trim() || null
        ]);
        res.status(201).json({ id: result.insertId, message: 'Gasto registrado' });
    } catch (error) {
        console.error('Error al registrar gasto:', error);
        res.status(400).json({ error: error.message || 'No se pudo registrar el gasto' });
    }
});

router.delete('/api/gastos/:id(\\d+)', async (req, res) => {
    try {
        const [result] = await db.query('DELETE FROM gastos WHERE id = ?', [Number(req.params.id)]);
        if (!result.affectedRows) return res.status(404).json({ error: 'Gasto no encontrado' });
        res.json({ message: 'Gasto eliminado' });
    } catch (error) {
        console.error('Error al eliminar gasto:', error);
        res.status(500).json({ error: 'No se pudo eliminar el gasto' });
    }
});

router.put('/api/gastos/fondo', async (req, res) => {
    try {
        const fecha = validateDate(req.body?.fecha || formatLocalDate());
        const monto = parseNonNegativeMoney(req.body?.monto, 'El fondo');
        const user = req.session?.user || {};
        await db.query(`
            INSERT INTO fondos_caja (fecha, monto, creado_por_id, creado_por_nombre)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                monto = VALUES(monto),
                creado_por_id = VALUES(creado_por_id),
                creado_por_nombre = VALUES(creado_por_nombre)
        `, [
            fecha,
            monto,
            Number(user.id) || null,
            String(user.nombre || user.usuario || '').trim() || null
        ]);
        res.json({ message: 'Fondo de caja guardado', monto });
    } catch (error) {
        console.error('Error al guardar fondo:', error);
        res.status(400).json({ error: error.message || 'No se pudo guardar el fondo' });
    }
});

router.post('/api/cortes-diarios', async (req, res) => {
    try {
        const fechaHoy = formatLocalDate();
        const fecha = validateDate(req.body?.fecha || fechaHoy);
        if (fecha !== fechaHoy) {
            return res.status(400).json({ error: 'El corte diario sólo puede resumir el día en curso' });
        }
        const corte = await createDailyCut(fecha, req.session?.user || {});
        res.status(201).json({ message: 'Corte realizado', corte });
    } catch (error) {
        console.error('Error al realizar corte:', error);
        res.status(500).json({ error: error.message || 'No se pudo realizar el corte' });
    }
});

module.exports = router;
