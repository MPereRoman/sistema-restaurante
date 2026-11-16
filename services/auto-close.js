const AUTO_CLOSE_HOUR = 20;
const AUTO_CLOSE_INTERVAL_MS = 60 * 1000;

function sameLocalDay(left, right) {
    return left.getFullYear() === right.getFullYear() &&
        left.getMonth() === right.getMonth() &&
        left.getDate() === right.getDate();
}

function shouldAutoClose(accountUpdatedAt, referenceDate = new Date()) {
    const updated = new Date(accountUpdatedAt);
    const now = new Date(referenceDate);
    if (Number.isNaN(updated.getTime()) || Number.isNaN(now.getTime()) || updated > now) return false;
    if (!sameLocalDay(updated, now)) return true;
    return now.getHours() >= AUTO_CLOSE_HOUR;
}

function autoCloseTimestamp(accountUpdatedAt, referenceDate = new Date()) {
    const updated = new Date(accountUpdatedAt);
    const now = new Date(referenceDate);
    if (sameLocalDay(updated, now)) return now;
    return new Date(updated.getFullYear(), updated.getMonth(), updated.getDate(), AUTO_CLOSE_HOUR, 0, 0, 0);
}

function normalizePayments(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(payment => payment && typeof payment === 'object').map(payment => ({
        metodo: String(payment.metodo || '').toLowerCase().trim(),
        monto: Number(payment.monto || 0),
        referencia: String(payment.referencia || '').trim() || null
    })).filter(payment => ['efectivo', 'transferencia'].includes(payment.metodo) && Number.isFinite(payment.monto) && payment.monto > 0);
}

function paymentMethod(payments) {
    return payments.length === 1 ? payments[0].metodo : 'mixto';
}

function itemsSignature(items) {
    return (items || []).map(item => [
        Number(item.id || 0), Number(item.producto_id || 0),
        Number(item.cantidad || 0), Number(item.subtotal || 0)
    ]).sort((left, right) => left[0] - right[0]);
}

async function replaceInvoiceContents(connection, invoiceId, items, payments) {
    await connection.query('DELETE FROM detalle_factura WHERE factura_id = ?', [invoiceId]);
    await connection.query('DELETE FROM factura_pagos WHERE factura_id = ?', [invoiceId]);
    await connection.query(
        'INSERT INTO detalle_factura (factura_id, producto_id, cantidad, precio_unitario, unidad_medida, subtotal) VALUES ?',
        [items.map(item => [invoiceId, item.producto_id, item.cantidad, item.precio_unitario, item.unidad_medida, item.subtotal])]
    );
    await connection.query(
        'INSERT INTO factura_pagos (factura_id, metodo, monto, referencia) VALUES ?',
        [payments.map(payment => [invoiceId, payment.metodo, payment.monto, payment.referencia])]
    );
}

async function closeOrderAutomatically(orderId, referenceDate = new Date(), database) {
    const db = database || require('../db');
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [orders] = await connection.query(`
            SELECT p.*, m.numero AS mesa_numero
            FROM pedidos p
            JOIN mesas m ON m.id = p.mesa_id
            WHERE p.id = ?
            FOR UPDATE
        `, [orderId]);
        if (!orders.length) throw new Error('Pedido no encontrado');
        const order = orders[0];
        if (['cerrado', 'cancelado', 'rechazado'].includes(String(order.estado || '').toLowerCase())) {
            await connection.rollback();
            return { orderId, skipped: true, reason: 'pedido finalizado' };
        }
        if (!shouldAutoClose(order.updated_at, referenceDate)) {
            await connection.rollback();
            return { orderId, skipped: true, reason: 'aún no corresponde cierre' };
        }

        let draft = null;
        try { draft = JSON.parse(order.pagos_borrador || 'null'); } catch (_) { draft = null; }
        const payments = normalizePayments(draft?.pagos);
        if (!payments.length) throw new Error('Cuenta sin forma de pago válida');

        const [items] = await connection.query(
            `SELECT * FROM pedido_items WHERE pedido_id = ? AND estado NOT IN ('cancelado','rechazado')`,
            [orderId]
        );
        if (!items.length) throw new Error('Pedido sin productos');
        const total = items.reduce((sum, item) => sum + Number(item.subtotal || 0), 0);
        const paymentsTotal = payments.reduce((sum, payment) => sum + Number(payment.monto || 0), 0);
        if (Math.abs(Number(draft.total) - total) >= 0.01 ||
            JSON.stringify(draft.items_firma || []) !== JSON.stringify(itemsSignature(items))) {
            throw new Error('La cuenta cambió después de ser generada');
        }
        if (paymentsTotal < total - 0.01) throw new Error('Los pagos no cubren el total');

        const closedAt = autoCloseTimestamp(order.updated_at, referenceDate);
        const [invoices] = await connection.query(
            'SELECT id, estado FROM facturas WHERE pedido_id = ? LIMIT 1 FOR UPDATE',
            [orderId]
        );
        let invoiceId;
        if (invoices.length) {
            if (invoices[0].estado !== 'borrador') throw new Error('La factura ya fue pagada');
            invoiceId = invoices[0].id;
            await connection.query(
                `UPDATE facturas SET total = ?, forma_pago = ?, estado = 'pagada', fecha = ? WHERE id = ?`,
                [total, paymentMethod(payments), closedAt, invoiceId]
            );
        } else {
            const [insert] = await connection.query(`
                INSERT INTO facturas (cliente_id, pedido_id, total, forma_pago, estado, fecha)
                VALUES (NULL, ?, ?, ?, 'pagada', ?)
            `, [orderId, total, paymentMethod(payments), closedAt]);
            invoiceId = insert.insertId;
        }

        await replaceInvoiceContents(connection, invoiceId, items, payments);
        await connection.query(`
            UPDATE pedidos
            SET estado = 'cerrado', total = ?, pagos_borrador = NULL,
                cierre_automatico = 1, cerrado_at = ?
            WHERE id = ?
        `, [total, closedAt, orderId]);
        await connection.query(`UPDATE mesas SET estado = 'libre' WHERE id = ?`, [order.mesa_id]);
        await connection.commit();
        return { orderId, invoiceId, total, closedAt, automatic: true };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function runAutomaticClose(referenceDate = new Date(), database) {
    const db = database || require('../db');
    const [rows] = await db.query(`
        SELECT id
        FROM pedidos
        WHERE estado NOT IN ('cerrado','cancelado','rechazado')
          AND pagos_borrador IS NOT NULL
          AND pagos_borrador <> ''
          AND (
              DATE(updated_at) < CURDATE()
              OR (DATE(updated_at) = CURDATE() AND CURTIME() >= '20:00:00')
          )
        ORDER BY id
    `);
    const results = [];
    for (const row of rows) {
        try {
            results.push(await closeOrderAutomatically(row.id, referenceDate, db));
        } catch (error) {
            const failure = { orderId: row.id, error: String(error?.message || error) };
            results.push(failure);
            console.error('No se pudo cerrar automáticamente el pedido:', failure);
        }
    }
    if (results.length) console.log('Cierre automático de cuentas ejecutado', results);
    return results;
}

function startAutomaticCloseScheduler() {
    const execute = () => runAutomaticClose().catch(error => console.error('Falló el programador de cierre automático:', error));
    execute();
    const timer = setInterval(execute, AUTO_CLOSE_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
}

module.exports = {
    AUTO_CLOSE_HOUR,
    shouldAutoClose,
    autoCloseTimestamp,
    closeOrderAutomatically,
    runAutomaticClose,
    startAutomaticCloseScheduler
};
