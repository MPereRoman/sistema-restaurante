const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

function formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Conserva la semana actual y la semana calendario inmediatamente anterior.
 * Ejemplo: durante 2026-11-16..22 conserva desde 2026-11-09;
 * el lunes 2026-11-23 avanza el corte a 2026-11-16.
 */
function getRetentionCutoff(referenceDate = new Date()) {
    const date = new Date(referenceDate);
    date.setHours(0, 0, 0, 0);
    const daysSinceMonday = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - daysSinceMonday - 7);
    return formatLocalDate(date);
}

async function purgeExpiredOperationalData(referenceDate = new Date()) {
    const db = require('../db');
    const cutoff = getRetentionCutoff(referenceDate);
    const connection = await db.getConnection();
    const deleted = {};
    try {
        await connection.beginTransaction();

        const runDelete = async (key, sql, params = [cutoff]) => {
            const [result] = await connection.query(sql, params);
            deleted[key] = Number(result?.affectedRows || 0);
        };

        await runDelete('detalle_factura', `
            DELETE df FROM detalle_factura df
            JOIN facturas f ON f.id = df.factura_id
            WHERE f.estado = 'pagada' AND f.fecha < ?
        `);
        await runDelete('factura_pagos', `
            DELETE fp FROM factura_pagos fp
            JOIN facturas f ON f.id = fp.factura_id
            WHERE f.estado = 'pagada' AND f.fecha < ?
        `);
        await runDelete('facturas', "DELETE FROM facturas WHERE estado = 'pagada' AND fecha < ?");

        const estadosFinales = ['cerrado', 'cancelado', 'rechazado'];
        await runDelete('pedido_items', `
            DELETE pi FROM pedido_items pi
            JOIN pedidos p ON p.id = pi.pedido_id
            WHERE p.updated_at < ? AND p.estado IN (?, ?, ?)
        `, [cutoff, ...estadosFinales]);
        await runDelete('pedidos', `
            DELETE FROM pedidos
            WHERE updated_at < ? AND estado IN (?, ?, ?)
        `, [cutoff, ...estadosFinales]);

        await runDelete('gastos', 'DELETE FROM gastos WHERE fecha < ?');
        await runDelete('fondos_caja', 'DELETE FROM fondos_caja WHERE fecha < ?');
        await runDelete('cortes_diarios', 'DELETE FROM cortes_diarios WHERE fecha < ?');

        await connection.commit();
        console.log('Retención semanal aplicada', { cutoff, deleted });
        return { cutoff, deleted };
    } catch (error) {
        await connection.rollback();
        console.error('No se pudo aplicar la retención semanal:', error);
        throw error;
    } finally {
        connection.release();
    }
}

function startRetentionScheduler() {
    const execute = () => purgeExpiredOperationalData().catch(() => {});
    execute();
    const timer = setInterval(execute, RETENTION_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
}

module.exports = { getRetentionCutoff, purgeExpiredOperationalData, startRetentionScheduler };
