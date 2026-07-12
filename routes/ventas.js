const express = require('express');
const router = express.Router();
const db = require('../db');

/**
 * Construye cláusula WHERE y params para filtros de ventas.
 * Relacionado con:
 * - views/ventas.ejs (filtros por fecha y búsqueda)
 * - routes/ventas.js (listado y export)
 */
function buildVentasWhere(queryParams) {
    const where = [];
    const params = [];

    if (queryParams.desde && queryParams.hasta) {
        where.push('DATE(f.fecha) BETWEEN ? AND ?');
        params.push(queryParams.desde, queryParams.hasta);
    }

    if (queryParams.q) {
        where.push('(c.nombre LIKE ? OR f.id LIKE ?)');
        const term = `%${queryParams.q}%`;
        params.push(term, term);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return { whereSql, params };
}

/**
 * Calcula totales por método usando factura_pagos (incluye facturas mixtas).
 * Si una factura no tiene registros en factura_pagos (legacy), cae a f.forma_pago + f.total.
 */
async function getTotalesPorMetodo(queryParams) {
    const { whereSql, params } = buildVentasWhere(queryParams);

    // Para el segundo SELECT (fallback) necesitamos agregar condición fp2.id IS NULL
    const whereSqlFallback = whereSql
        ? `${whereSql} AND fp2.id IS NULL`
        : 'WHERE fp2.id IS NULL';

    // params se usa dos veces (UNION)
    const unionParams = [...params, ...params];

    // Solo totalizamos los métodos reales (no "mixto")
    const sql = `
        SELECT metodo, SUM(monto) AS total
        FROM (
            -- Facturas con pagos detallados
            SELECT fp.metodo AS metodo, fp.monto AS monto
            FROM factura_pagos fp
            JOIN facturas f ON f.id = fp.factura_id
            JOIN clientes c ON f.cliente_id = c.id
            ${whereSql}

            UNION ALL

            -- Fallback legacy: facturas sin registros en factura_pagos
            SELECT f.forma_pago AS metodo, f.total AS monto
            FROM facturas f
            JOIN clientes c ON f.cliente_id = c.id
            LEFT JOIN factura_pagos fp2 ON fp2.factura_id = f.id
            ${whereSqlFallback}
        ) t
        WHERE t.metodo IN ('efectivo','transferencia','tarjeta','qr')
        GROUP BY t.metodo
    `;

    const totales = { efectivo: 0, transferencia: 0, tarjeta: 0, qr: 0, general: 0 };

    try {
        const [rows] = await db.query(sql, unionParams);
        (rows || []).forEach(r => {
            const metodo = String(r.metodo || '').toLowerCase();
            const val = Number(r.total || 0);
            if (metodo === 'efectivo') totales.efectivo = val;
            if (metodo === 'transferencia') totales.transferencia = val;
            if (metodo === 'tarjeta') totales.tarjeta = val;
            if (metodo === 'qr') totales.qr = val;
        });
    } catch (err) {
        // Si no existe factura_pagos (instalación vieja), no rompemos: fallback a forma_pago
        try {
            const sqlOld = `
                SELECT f.forma_pago AS metodo, SUM(f.total) AS total
                FROM facturas f
                JOIN clientes c ON f.cliente_id = c.id
                ${whereSql}
                GROUP BY f.forma_pago
            `;
            const [rowsOld] = await db.query(sqlOld, params);
            (rowsOld || []).forEach(r => {
                const metodo = String(r.metodo || '').toLowerCase();
                const val = Number(r.total || 0);
                if (metodo === 'efectivo') totales.efectivo = val;
                if (metodo === 'transferencia') totales.transferencia = val;
                if (metodo === 'tarjeta') totales.tarjeta = val;
                if (metodo === 'qr') totales.qr = val;
            });
        } catch (_) {
            // si todo falla, dejamos en 0
        }
        console.error('Error calculando totales por método:', err);
    }

    totales.general = Number(totales.efectivo) + Number(totales.transferencia) + Number(totales.tarjeta) + Number(totales.qr);
    return totales;
}

async function getProductosMasVendidos(queryParams) {
    const { whereSql, params } = buildVentasWhere(queryParams);
    const sql = `
        SELECT p.nombre,
               SUM(df.cantidad) AS total_cantidad,
               SUM(df.subtotal) AS total_ingresos
        FROM detalle_factura df
        JOIN facturas  f ON f.id = df.factura_id
        JOIN clientes  c ON f.cliente_id = c.id
        JOIN productos p ON p.id = df.producto_id
        ${whereSql}
        GROUP BY p.id, p.nombre
        ORDER BY total_cantidad DESC
        LIMIT 10
    `;
    try {
        const [rows] = await db.query(sql, params);
        return (rows || []).map(r => ({
            nombre: r.nombre,
            total_cantidad: Number(r.total_cantidad || 0),
            total_ingresos: Number(r.total_ingresos || 0)
        }));
    } catch (_) { return []; }
}

async function getDiasMasMovimiento(queryParams) {
    const { whereSql, params } = buildVentasWhere(queryParams);
    const sql = `
        SELECT DAYOFWEEK(f.fecha) AS dia_num,
               COUNT(*)            AS num_ventas,
               SUM(f.total)        AS total_ventas
        FROM facturas f
        JOIN clientes c ON f.cliente_id = c.id
        ${whereSql}
        GROUP BY DAYOFWEEK(f.fecha)
        ORDER BY dia_num
    `;
    try {
        const [rows] = await db.query(sql, params);
        return (rows || []).map(r => ({
            dia_num: Number(r.dia_num),
            num_ventas: Number(r.num_ventas || 0),
            total_ventas: Number(r.total_ventas || 0)
        }));
    } catch (_) { return []; }
}

async function getHorasPico(queryParams) {
    const { whereSql, params } = buildVentasWhere(queryParams);
    const sql = `
        SELECT HOUR(f.fecha) AS hora,
               COUNT(*)       AS num_ventas,
               SUM(f.total)   AS total_ventas
        FROM facturas f
        JOIN clientes c ON f.cliente_id = c.id
        ${whereSql}
        GROUP BY HOUR(f.fecha)
        ORDER BY hora
    `;
    try {
        const [rows] = await db.query(sql, params);
        return (rows || []).map(r => ({
            hora: Number(r.hora),
            num_ventas: Number(r.num_ventas || 0),
            total_ventas: Number(r.total_ventas || 0)
        }));
    } catch (_) { return []; }
}

async function getKPIs(queryParams) {
    const { whereSql, params } = buildVentasWhere(queryParams);
    const sql = `
        SELECT COUNT(*)     AS num_facturas,
               AVG(f.total) AS ticket_promedio,
               MAX(f.total) AS venta_maxima
        FROM facturas f
        JOIN clientes c ON f.cliente_id = c.id
        ${whereSql}
    `;
    try {
        const [rows] = await db.query(sql, params);
        const r = (rows && rows[0]) ? rows[0] : {};
        return {
            num_facturas:    Number(r.num_facturas   || 0),
            ticket_promedio: Number(r.ticket_promedio|| 0),
            venta_maxima:    Number(r.venta_maxima   || 0)
        };
    } catch (_) { return { num_facturas: 0, ticket_promedio: 0, venta_maxima: 0 }; }
}

// Ruta principal de ventas con filtros opcionales por fecha
router.get('/', async (req, res) => {
    try {
        const { whereSql, params } = buildVentasWhere(req.query);
        const query = `
            SELECT f.*, c.nombre as cliente_nombre
            FROM facturas f
            JOIN clientes c ON f.cliente_id = c.id
            ${whereSql}
            ORDER BY f.fecha DESC
        `;

        const [ventas] = await db.query(query, params);
        const [totales, productos, dias, horas, kpis] = await Promise.all([
            getTotalesPorMetodo(req.query),
            getProductosMasVendidos(req.query),
            getDiasMasMovimiento(req.query),
            getHorasPico(req.query),
            getKPIs(req.query)
        ]);
        const analytics = { productos, dias, horas, kpis };
        res.render('ventas', { ventas, totales, analytics });
    } catch (error) {
        console.error('Error al obtener ventas:', error);
        res.status(500).send('Error al cargar el historial de ventas');
    }
});

// ─── helpers de formato para el Excel ────────────────────────────────────────
function fmtMetodo(m) {
    const map = { efectivo: 'Efectivo', transferencia: 'Transferencia', tarjeta: 'Tarjeta', qr: 'QR', mixto: 'Mixto' };
    return map[String(m || '').toLowerCase()] || (String(m || '').charAt(0).toUpperCase() + String(m || '').slice(1));
}

function autoFitColumns(ws, minW = 10, maxW = 45) {
    ws.columns.forEach(col => {
        let max = minW;
        col.eachCell({ includeEmpty: false }, cell => {
            const v = cell.value;
            const len = v != null ? String(v).length : 0;
            if (len > max) max = len;
        });
        col.width = Math.min(maxW, max + 2);
    });
}

function applyHeaderStyle(row, bgArgb = 'FF1E3A5F') {
    row.eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = {
            top:    { style: 'thin', color: { argb: 'FFB0BEC5' } },
            bottom: { style: 'thin', color: { argb: 'FFB0BEC5' } },
            left:   { style: 'thin', color: { argb: 'FFB0BEC5' } },
            right:  { style: 'thin', color: { argb: 'FFB0BEC5' } }
        };
    });
    row.height = 22;
}

function addLogoToSheet(wb, ws, logoData, logoTipo) {
    if (!logoData) return;
    try {
        const ext = (logoTipo || '').includes('png') ? 'png' : 'jpeg';
        const imgId = wb.addImage({ buffer: Buffer.from(logoData), extension: ext });
        ws.addImage(imgId, { tl: { col: 0, row: 0 }, ext: { width: 90, height: 54 } });
    } catch (_) {}
}

function buildEncabezadoSheet(wb, ws, config, titulo, subtitulo, rangoTexto) {
    // Filas 1-4: encabezado corporativo (col A = logo, cols B-J = info)
    const COLS = 10;
    for (let r = 1; r <= 4; r++) {
        ws.mergeCells(r, 2, r, COLS);
    }
    ws.getRow(1).values = ['', titulo];
    ws.getRow(2).values = ['', subtitulo || ''];
    ws.getRow(3).values = ['', rangoTexto || ''];
    ws.getRow(4).values = ['', `Generado: ${new Date().toLocaleString('es-CO')}`];

    ws.getRow(1).font = { bold: true, size: 18, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    ws.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 32;

    ws.getRow(2).font = { size: 11, color: { argb: 'FF1E3A5F' } };
    ws.getRow(2).alignment = { horizontal: 'center' };
    ws.getRow(2).height = 18;

    ws.getRow(3).font = { italic: true, size: 10, color: { argb: 'FF546E7A' } };
    ws.getRow(3).alignment = { horizontal: 'center' };
    ws.getRow(3).height = 16;

    ws.getRow(4).font = { italic: true, size: 9, color: { argb: 'FF90A4AE' } };
    ws.getRow(4).alignment = { horizontal: 'center' };
    ws.getRow(4).height = 14;

    addLogoToSheet(wb, ws, config?.logo_data, config?.logo_tipo);
    ws.addRow([]); // fila 5 separadora
}

// GET /ventas/export - Exportar Excel profesional (3 hojas)
router.get('/export', async (req, res) => {
    try {
        let ExcelJS;
        try {
            ExcelJS = require('exceljs');
        } catch (e) {
            return res.status(500).send('Exportación a Excel no disponible. Instale la dependencia con: npm install exceljs');
        }

        // ── Datos base ────────────────────────────────────────────────────────
        const { whereSql, params } = buildVentasWhere(req.query);
        const queryFinal = `
            SELECT f.id, f.fecha, c.nombre AS cliente, f.forma_pago, f.total,
                   p.nombre AS producto,
                   df.cantidad, df.precio_unitario, df.subtotal AS subtotal_item, df.unidad_medida
            FROM facturas f
            JOIN clientes c ON f.cliente_id = c.id
            LEFT JOIN detalle_factura df ON df.factura_id = f.id
            LEFT JOIN productos p ON p.id = df.producto_id
            ${whereSql}
            ORDER BY f.fecha DESC, f.id, p.nombre
        `;
        const [rows] = await db.query(queryFinal, params);
        const [totales, kpis] = await Promise.all([
            getTotalesPorMetodo(req.query),
            getKPIs(req.query)
        ]);

        // Contar transacciones por método
        let transaccionesPorMetodo = { efectivo: 0, transferencia: 0, tarjeta: 0, qr: 0 };
        try {
            const sqlTx = `
                SELECT fp.metodo, COUNT(DISTINCT fp.factura_id) AS num
                FROM factura_pagos fp
                JOIN facturas f ON f.id = fp.factura_id
                JOIN clientes c ON f.cliente_id = c.id
                ${whereSql}
                WHERE fp.metodo IN ('efectivo','transferencia','tarjeta','qr')
                GROUP BY fp.metodo
            `;
            const [txRows] = await db.query(sqlTx, params);
            (txRows || []).forEach(r => {
                const m = String(r.metodo || '').toLowerCase();
                if (transaccionesPorMetodo[m] !== undefined) transaccionesPorMetodo[m] = Number(r.num || 0);
            });
        } catch (_) {}

        let config = null;
        try {
            const [cfg] = await db.query('SELECT * FROM configuracion_impresion LIMIT 1');
            config = cfg?.[0] || null;
        } catch (_) {}

        const negocio = config?.nombre_negocio || 'Reporte de Ventas';
        const subInfo = [
            config?.direccion,
            config?.telefono ? `Tel: ${config.telefono}` : null,
            config?.nit ? `NIT: ${config.nit}` : null
        ].filter(Boolean).join('  •  ');
        const rangoTexto = `Período: ${req.query.desde || 'inicio'} → ${req.query.hasta || 'hoy'}${req.query.q ? '  |  Filtro: ' + req.query.q : ''}`;

        // ── Workbook ──────────────────────────────────────────────────────────
        const wb = new ExcelJS.Workbook();
        wb.creator = negocio;
        wb.created = new Date();
        wb.modified = new Date();

        const MONEDA = '#,##0.00';

        // ════════════════════════════════════════════════════════════════════
        // HOJA 1 — RESUMEN EJECUTIVO
        // ════════════════════════════════════════════════════════════════════
        const wsR = wb.addWorksheet('Resumen Ejecutivo', {
            pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true }
        });

        buildEncabezadoSheet(wb, wsR, config, negocio, subInfo, rangoTexto);

        // KPIs
        const kpiData = [
            ['Total Ventas (General)',  Number(totales.general || 0), 'moneda', 'FF1E3A5F'],
            ['N° Facturas Emitidas',    Number(kpis.num_facturas || 0), 'numero', 'FF37474F'],
            ['Ticket Promedio',         Number(kpis.ticket_promedio || 0), 'moneda', 'FF1B5E20'],
            ['Venta Máxima',            Number(kpis.venta_maxima || 0), 'moneda', 'FF4A148C'],
        ];
        const kpiHeader = wsR.addRow(['', 'INDICADORES CLAVE DE RENDIMIENTO', '', '', '']);
        wsR.mergeCells(kpiHeader.number, 2, kpiHeader.number, 5);
        kpiHeader.getCell(2).font = { bold: true, size: 11, color: { argb: 'FF1E3A5F' } };
        kpiHeader.getCell(2).alignment = { horizontal: 'left' };
        kpiHeader.height = 20;
        wsR.addRow([]);

        kpiData.forEach(([label, value, tipo, color]) => {
            const r = wsR.addRow(['', label, '', value]);
            wsR.mergeCells(r.number, 2, r.number, 3);
            r.getCell(2).font = { bold: true, size: 11, color: { argb: 'FF37474F' } };
            r.getCell(2).alignment = { horizontal: 'left', vertical: 'middle' };
            r.getCell(4).font = { bold: true, size: 14, color: { argb: color } };
            r.getCell(4).alignment = { horizontal: 'right', vertical: 'middle' };
            if (tipo === 'moneda') r.getCell(4).numFmt = MONEDA;
            r.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
            r.height = 24;
            // Borde inferior suave
            [2,3,4].forEach(c => {
                r.getCell(c).border = { bottom: { style: 'hair', color: { argb: 'FFECEFF1' } } };
            });
        });

        wsR.addRow([]);
        wsR.addRow([]);

        // Tabla de totales por método de pago
        const metHeader = wsR.addRow(['', 'TOTALES POR MÉTODO DE PAGO', '', '', '', '']);
        wsR.mergeCells(metHeader.number, 2, metHeader.number, 6);
        metHeader.getCell(2).font = { bold: true, size: 11, color: { argb: 'FF1E3A5F' } };
        metHeader.getCell(2).alignment = { horizontal: 'left' };
        metHeader.height = 20;

        const colsMetodo = ['', 'Método de Pago', 'N° Transacciones', 'Monto Total', '% del Total', ''];
        const metColHeader = wsR.addRow(colsMetodo);
        applyHeaderStyle(metColHeader, 'FF1E3A5F');
        wsR.mergeCells(metColHeader.number, 1, metColHeader.number, 1);

        const totalGeneral = Number(totales.general || 1);
        const metodosResumen = [
            ['Efectivo',       totales.efectivo,       transaccionesPorMetodo.efectivo],
            ['Transferencia',  totales.transferencia,  transaccionesPorMetodo.transferencia],
        ];
        metodosResumen.forEach(([nombre, monto, txCount], idx) => {
            const pct = totalGeneral > 0 ? Number(monto || 0) / totalGeneral : 0;
            const r = wsR.addRow(['', nombre, txCount, Number(monto || 0), pct, '']);
            r.getCell(2).font = { bold: true };
            r.getCell(3).alignment = { horizontal: 'center' };
            r.getCell(4).numFmt = MONEDA;
            r.getCell(4).alignment = { horizontal: 'right' };
            r.getCell(5).numFmt = '0.0%';
            r.getCell(5).alignment = { horizontal: 'center' };
            r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: idx % 2 === 0 ? 'FFFAFAFA' : 'FFECEFF1' } };
            r.height = 18;
        });
        // Fila de total general
        const totalRow = wsR.addRow(['', 'TOTAL GENERAL', '', Number(totales.general || 0), 1, '']);
        totalRow.getCell(2).font = { bold: true, size: 11 };
        totalRow.getCell(4).numFmt = MONEDA;
        totalRow.getCell(4).font = { bold: true, size: 11, color: { argb: 'FF1B5E20' } };
        totalRow.getCell(4).alignment = { horizontal: 'right' };
        totalRow.getCell(5).numFmt = '0.0%';
        totalRow.getCell(5).alignment = { horizontal: 'center' };
        totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
        totalRow.height = 22;
        [2,3,4,5].forEach(c => {
            totalRow.getCell(c).border = { top: { style: 'medium', color: { argb: 'FF1B5E20' } } };
        });

        wsR.getColumn(1).width = 4;
        wsR.getColumn(2).width = 28;
        wsR.getColumn(3).width = 18;
        wsR.getColumn(4).width = 18;
        wsR.getColumn(5).width = 14;
        wsR.views = [{ state: 'frozen', ySplit: 5 }];

        // ════════════════════════════════════════════════════════════════════
        // HOJA 2 — DETALLE DE VENTAS
        // ════════════════════════════════════════════════════════════════════
        const wsD = wb.addWorksheet('Detalle de Ventas', {
            pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true }
        });

        buildEncabezadoSheet(wb, wsD, config, `${negocio} — Detalle de Ventas`, subInfo, rangoTexto);

        const detColNames = [
            'Factura #', 'Fecha', 'Cliente', 'Método Pago',
            'Producto', 'Cantidad', 'Unidad', 'Precio Unitario', 'Subtotal Ítem', 'Total Factura'
        ];
        const detHeader = wsD.addRow(detColNames);
        applyHeaderStyle(detHeader, 'FF1E3A5F');
        wsD.views = [{ state: 'frozen', ySplit: detHeader.number }];

        let prevFacturaId = null;
        rows.forEach(r => {
            const isFirstOfFactura = (r.id !== prevFacturaId);
            prevFacturaId = r.id;

            const fecha = new Date(r.fecha);
            const totalFactura = isFirstOfFactura ? Number(r.total || 0) : null;

            const dataRow = wsD.addRow([
                r.id,
                fecha.toLocaleString('es-CO'),
                r.cliente || '',
                fmtMetodo(r.forma_pago),
                r.producto || '(sin producto)',
                Number(r.cantidad || 0),
                (r.unidad_medida || ''),
                Number(r.precio_unitario || 0),
                Number(r.subtotal_item || 0),
                totalFactura
            ]);

            // Zebra striping por factura (alterna por id de factura)
            const bgArgb = (r.id % 2 === 0) ? 'FFFAFAFA' : 'FFECEFF1';
            dataRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } };

            // Formatos numéricos
            dataRow.getCell(6).numFmt  = '#,##0.##';   // cantidad
            dataRow.getCell(8).numFmt  = MONEDA;        // precio unitario
            dataRow.getCell(9).numFmt  = MONEDA;        // subtotal item
            if (totalFactura !== null) {
                dataRow.getCell(10).numFmt = MONEDA;
                dataRow.getCell(10).font = { bold: true, color: { argb: 'FF1B5E20' } };
            }
            dataRow.getCell(1).alignment = { horizontal: 'center' };
            dataRow.getCell(4).alignment = { horizontal: 'center' };
            dataRow.getCell(6).alignment = { horizontal: 'center' };
            dataRow.getCell(7).alignment = { horizontal: 'center' };
            dataRow.getCell(8).alignment = { horizontal: 'right' };
            dataRow.getCell(9).alignment = { horizontal: 'right' };
            dataRow.getCell(10).alignment = { horizontal: 'right' };
            dataRow.height = 16;
        });

        // Si no hay datos
        if (rows.length === 0) {
            const emptyRow = wsD.addRow(['', '', 'No se encontraron ventas para el período indicado.']);
            wsD.mergeCells(emptyRow.number, 3, emptyRow.number, 10);
            emptyRow.getCell(3).font = { italic: true, color: { argb: 'FF90A4AE' } };
        }

        // Totales al pie de la hoja Detalle
        wsD.addRow([]);
        const detTotalRow = wsD.addRow(['', '', '', '', '', '', '', 'Total General:', Number(totales.general || 0), '']);
        detTotalRow.getCell(8).font = { bold: true, size: 11 };
        detTotalRow.getCell(8).alignment = { horizontal: 'right' };
        detTotalRow.getCell(9).numFmt = MONEDA;
        detTotalRow.getCell(9).font = { bold: true, size: 12, color: { argb: 'FF1B5E20' } };
        detTotalRow.getCell(9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
        detTotalRow.getCell(9).border = { top: { style: 'medium', color: { argb: 'FF1B5E20' } } };

        // Anchos fijos para hoja Detalle
        wsD.getColumn(1).width  = 11;  // Factura #
        wsD.getColumn(2).width  = 20;  // Fecha
        wsD.getColumn(3).width  = 30;  // Cliente
        wsD.getColumn(4).width  = 16;  // Método pago
        wsD.getColumn(5).width  = 32;  // Producto
        wsD.getColumn(6).width  = 12;  // Cantidad
        wsD.getColumn(7).width  = 10;  // Unidad
        wsD.getColumn(8).width  = 18;  // Precio unitario
        wsD.getColumn(9).width  = 18;  // Subtotal ítem
        wsD.getColumn(10).width = 18;  // Total factura

        // ════════════════════════════════════════════════════════════════════
        // HOJA 3 — RESUMEN POR MÉTODO DE PAGO
        // ════════════════════════════════════════════════════════════════════
        const wsM = wb.addWorksheet('Por Método de Pago', {
            pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true }
        });

        buildEncabezadoSheet(wb, wsM, config, `${negocio} — Métodos de Pago`, subInfo, rangoTexto);

        const mColHeader = wsM.addRow(['Método de Pago', 'N° Transacciones', 'Monto Total', '% del Total', 'Barra visual']);
        applyHeaderStyle(mColHeader, 'FF1E3A5F');
        wsM.views = [{ state: 'frozen', ySplit: mColHeader.number }];

        const metodosDetalle = [
            { nombre: 'Efectivo',      monto: totales.efectivo,      tx: transaccionesPorMetodo.efectivo,      color: 'FF43A047' },
            { nombre: 'Transferencia', monto: totales.transferencia,  tx: transaccionesPorMetodo.transferencia,  color: 'FF1E88E5' },
        ];
        const sumMetodos = metodosDetalle.reduce((a, m) => a + Number(m.monto || 0), 0) || 1;

        metodosDetalle.forEach((m, idx) => {
            const pct = sumMetodos > 0 ? Number(m.monto || 0) / sumMetodos : 0;
            const barras = '█'.repeat(Math.round(pct * 20));
            const r = wsM.addRow([m.nombre, m.tx, Number(m.monto || 0), pct, barras]);
            r.getCell(1).font = { bold: true, color: { argb: m.color } };
            r.getCell(2).alignment = { horizontal: 'center' };
            r.getCell(3).numFmt = MONEDA;
            r.getCell(3).alignment = { horizontal: 'right' };
            r.getCell(4).numFmt = '0.0%';
            r.getCell(4).alignment = { horizontal: 'center' };
            r.getCell(5).font = { color: { argb: m.color } };
            r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: idx % 2 === 0 ? 'FFFAFAFA' : 'FFECEFF1' } };
            r.height = 22;
        });

        // Fila de total en hoja 3
        const mTotalRow = wsM.addRow(['TOTAL', '', Number(totales.general || 0), 1, '']);
        mTotalRow.getCell(1).font = { bold: true, size: 11 };
        mTotalRow.getCell(3).numFmt = MONEDA;
        mTotalRow.getCell(3).font = { bold: true, size: 11, color: { argb: 'FF1B5E20' } };
        mTotalRow.getCell(3).alignment = { horizontal: 'right' };
        mTotalRow.getCell(4).numFmt = '0.0%';
        mTotalRow.getCell(4).alignment = { horizontal: 'center' };
        mTotalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
        mTotalRow.height = 24;
        [1,2,3,4].forEach(c => {
            mTotalRow.getCell(c).border = { top: { style: 'medium', color: { argb: 'FF1B5E20' } } };
        });

        wsM.addRow([]);
        // Nota al pie
        const notaRow = wsM.addRow(['* Las transacciones QR/Transferencia pueden incluir referencia de pago. Consulte el Detalle para más información.']);
        wsM.mergeCells(notaRow.number, 1, notaRow.number, 5);
        notaRow.getCell(1).font = { italic: true, size: 9, color: { argb: 'FF90A4AE' } };

        wsM.getColumn(1).width = 20;
        wsM.getColumn(2).width = 18;
        wsM.getColumn(3).width = 18;
        wsM.getColumn(4).width = 14;
        wsM.getColumn(5).width = 25;

        // ── Enviar respuesta ──────────────────────────────────────────────
        const desde = (req.query.desde || 'all').replace(/-/g, '');
        const hasta = (req.query.hasta || 'all').replace(/-/g, '');
        const filename = `ventas_${desde}_${hasta}.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        await wb.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('Error al exportar ventas:', error);
        res.status(500).send('Error al exportar');
    }
});

module.exports = router; 
