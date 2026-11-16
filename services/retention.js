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

function getWeekArchiveMetadata(weekStart) {
    const [year, month, day] = String(weekStart).split('-').map(Number);
    const start = new Date(year, month - 1, day, 12);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);

    // ISO-8601: la semana y el año corresponden al jueves de esa semana.
    const thursday = new Date(start);
    thursday.setDate(thursday.getDate() + 3);
    const isoYear = thursday.getFullYear();
    const firstThursday = new Date(isoYear, 0, 4, 12);
    const firstMonday = new Date(firstThursday);
    firstMonday.setDate(firstMonday.getDate() - ((firstMonday.getDay() + 6) % 7));
    const weekNumber = Math.floor((start - firstMonday) / (7 * 24 * 60 * 60 * 1000)) + 1;

    return {
        semana_inicio: formatLocalDate(start),
        semana_fin: formatLocalDate(end),
        anio: isoYear,
        numero_semana: weekNumber
    };
}

async function archiveExpiredWeeklySummaries(connection, cutoff) {
    const [salesRows] = await connection.query(`
        SELECT DATE_FORMAT(DATE_SUB(DATE(fecha), INTERVAL WEEKDAY(fecha) DAY), '%Y-%m-%d') AS semana_inicio,
               COALESCE(SUM(total), 0) AS total_ventas
        FROM facturas
        WHERE estado = 'pagada' AND fecha < ?
        GROUP BY DATE_SUB(DATE(fecha), INTERVAL WEEKDAY(fecha) DAY)
    `, [cutoff]);
    const [expenseRows] = await connection.query(`
        SELECT DATE_FORMAT(DATE_SUB(fecha, INTERVAL WEEKDAY(fecha) DAY), '%Y-%m-%d') AS semana_inicio,
               COALESCE(SUM(total), 0) AS total_gastos
        FROM gastos
        WHERE fecha < ?
        GROUP BY DATE_SUB(fecha, INTERVAL WEEKDAY(fecha) DAY)
    `, [cutoff]);

    const summaries = new Map();
    for (const row of salesRows) {
        summaries.set(row.semana_inicio, {
            total_ventas: Number(row.total_ventas || 0),
            total_gastos: 0
        });
    }
    for (const row of expenseRows) {
        const current = summaries.get(row.semana_inicio) || { total_ventas: 0, total_gastos: 0 };
        current.total_gastos = Number(row.total_gastos || 0);
        summaries.set(row.semana_inicio, current);
    }

    for (const [weekStart, summary] of summaries) {
        const week = getWeekArchiveMetadata(weekStart);
        const net = Math.round((summary.total_ventas - summary.total_gastos) * 100) / 100;
        await connection.query(`
            INSERT INTO resumenes_semanales
                (semana_inicio, semana_fin, anio, numero_semana, neto)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                neto = neto + VALUES(neto),
                archived_at = CURRENT_TIMESTAMP
        `, [
            week.semana_inicio,
            week.semana_fin,
            week.anio,
            week.numero_semana,
            net
        ]);
    }

    return { weeks: summaries.size };
}

async function purgeExpiredOperationalData(referenceDate = new Date()) {
    const db = require('../db');
    const cutoff = getRetentionCutoff(referenceDate);
    const connection = await db.getConnection();
    const deleted = {};
    try {
        await connection.beginTransaction();

        // El resumen se escribe en la misma transacción que la depuración: si
        // cualquier borrado falla, tampoco queda un histórico duplicado.
        const archived = await archiveExpiredWeeklySummaries(connection, cutoff);

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
        console.log('Retención semanal aplicada', { cutoff, archived, deleted });
        return { cutoff, archived, deleted };
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

module.exports = {
    getRetentionCutoff,
    getWeekArchiveMetadata,
    archiveExpiredWeeklySummaries,
    purgeExpiredOperationalData,
    startRetentionScheduler
};
