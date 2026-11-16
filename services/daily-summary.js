const db = require('../db');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value) {
    if (!ISO_DATE_RE.test(String(value || ''))) return false;
    const [year, month, day] = String(value).split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function formatLocalDate(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

async function getDailySummary(fecha, executor = db, options = {}) {
    if (!isIsoDate(fecha)) throw new Error('Fecha inválida');

    const [facturasRows] = await executor.query(`
        SELECT COUNT(*) AS numero_facturas,
               COALESCE(SUM(total), 0) AS total_ventas,
               MIN(fecha) AS primera_venta,
               MAX(fecha) AS ultima_venta
        FROM facturas
        WHERE estado = 'pagada'
          AND fecha >= ?
          AND fecha < DATE_ADD(?, INTERVAL 1 DAY)
    `, [fecha, fecha]);

    const pagos = { efectivo: 0, transferencia: 0, tarjeta: 0, qr: 0 };
    try {
        const [pagosRows] = await executor.query(`
            SELECT metodo, COALESCE(SUM(monto), 0) AS total
            FROM (
                SELECT fp.metodo, fp.monto
                FROM factura_pagos fp
                JOIN facturas f ON f.id = fp.factura_id
                WHERE f.estado = 'pagada'
                  AND f.fecha >= ?
                  AND f.fecha < DATE_ADD(?, INTERVAL 1 DAY)

                UNION ALL

                SELECT f.forma_pago AS metodo, f.total AS monto
                FROM facturas f
                LEFT JOIN factura_pagos fp ON fp.factura_id = f.id
                WHERE f.estado = 'pagada'
                  AND f.fecha >= ?
                  AND f.fecha < DATE_ADD(?, INTERVAL 1 DAY)
                  AND fp.id IS NULL
            ) pagos_dia
            WHERE metodo IN ('efectivo','transferencia','tarjeta','qr')
            GROUP BY metodo
        `, [fecha, fecha, fecha, fecha]);
        for (const row of pagosRows || []) {
            const metodo = String(row.metodo || '').toLowerCase();
            if (Object.prototype.hasOwnProperty.call(pagos, metodo)) pagos[metodo] = Number(row.total || 0);
        }
    } catch (error) {
        if (error?.code !== 'ER_NO_SUCH_TABLE') throw error;
        const [legacyRows] = await executor.query(`
            SELECT forma_pago AS metodo, COALESCE(SUM(total), 0) AS total
            FROM facturas
            WHERE estado = 'pagada'
              AND fecha >= ?
              AND fecha < DATE_ADD(?, INTERVAL 1 DAY)
            GROUP BY forma_pago
        `, [fecha, fecha]);
        for (const row of legacyRows || []) {
            const metodo = String(row.metodo || '').toLowerCase();
            if (Object.prototype.hasOwnProperty.call(pagos, metodo)) pagos[metodo] = Number(row.total || 0);
        }
    }

    const [gastosRows] = await executor.query(`
        SELECT COALESCE(SUM(total), 0) AS total_gastos,
               COALESCE(SUM(CASE WHEN metodo_pago = 'efectivo' THEN total ELSE 0 END), 0) AS gastos_efectivo
        FROM gastos
        WHERE fecha = ?
    `, [fecha]);
    const [fondoRows] = await executor.query('SELECT monto FROM fondos_caja WHERE fecha = ? LIMIT 1', [fecha]);

    const factura = facturasRows?.[0] || {};
    const gasto = gastosRows?.[0] || {};
    const totalVentas = Number(factura.total_ventas || 0);
    const totalGastos = Number(gasto.total_gastos || 0);
    const gastosEfectivo = Number(gasto.gastos_efectivo || 0);
    const fondoCaja = Number(fondoRows?.[0]?.monto || 0);

    const resumen = {
        fecha,
        numero_facturas: Number(factura.numero_facturas || 0),
        total_efectivo: pagos.efectivo,
        total_transferencia: pagos.transferencia,
        total_tarjeta: pagos.tarjeta,
        total_qr: pagos.qr,
        total_ventas: totalVentas,
        total_gastos: totalGastos,
        gastos_efectivo: gastosEfectivo,
        fondo_caja: fondoCaja,
        resultado_operativo: totalVentas - totalGastos,
        saldo_caja_estimado: fondoCaja + pagos.efectivo - gastosEfectivo,
        primera_venta: factura.primera_venta || null,
        ultima_venta: factura.ultima_venta || null
    };

    if (options.includeDetails) {
        const [gastos] = await executor.query(`
            SELECT id, fecha, concepto, total, metodo_pago, creado_por_nombre, created_at
            FROM gastos
            WHERE fecha = ?
            ORDER BY created_at DESC, id DESC
        `, [fecha]);
        const [cortes] = await executor.query(`
            SELECT id, fecha, numero_facturas, total_ventas, total_gastos, fondo_caja,
                   resultado_operativo, saldo_caja_estimado, creado_por_nombre, created_at
            FROM cortes_diarios
            WHERE fecha = ?
            ORDER BY created_at DESC, id DESC
            LIMIT 20
        `, [fecha]);
        resumen.gastos = gastos || [];
        resumen.cortes = cortes || [];
    }

    return resumen;
}

async function createDailyCut(fecha, user) {
    if (!isIsoDate(fecha)) throw new Error('Fecha inválida');
    const connection = await db.getConnection();
    try {
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await connection.beginTransaction();
        const resumen = await getDailySummary(fecha, connection);
        const creadoPorId = Number(user?.id) || null;
        const creadoPorNombre = String(user?.nombre || user?.usuario || '').trim() || null;
        const [result] = await connection.query(`
            INSERT INTO cortes_diarios (
                fecha, numero_facturas, total_efectivo, total_transferencia, total_tarjeta, total_qr,
                total_ventas, total_gastos, gastos_efectivo, fondo_caja, resultado_operativo,
                saldo_caja_estimado, primera_venta, ultima_venta, creado_por_id, creado_por_nombre
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            resumen.fecha,
            resumen.numero_facturas,
            resumen.total_efectivo,
            resumen.total_transferencia,
            resumen.total_tarjeta,
            resumen.total_qr,
            resumen.total_ventas,
            resumen.total_gastos,
            resumen.gastos_efectivo,
            resumen.fondo_caja,
            resumen.resultado_operativo,
            resumen.saldo_caja_estimado,
            resumen.primera_venta,
            resumen.ultima_venta,
            creadoPorId,
            creadoPorNombre
        ]);
        await connection.commit();
        return { id: result.insertId, ...resumen, creado_por_nombre: creadoPorNombre };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

module.exports = { createDailyCut, formatLocalDate, getDailySummary, isIsoDate };
