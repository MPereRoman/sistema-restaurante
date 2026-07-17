const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { resolvePrinterName } = require('./printer');

const recentJobs = new Map();
const DEDUPE_MS = 15000;

function escapeXml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function money(value) {
    return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function wrapText(value, maxChars) {
    const words = String(value == null ? '' : value).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [''];
    const lines = [];
    let line = '';
    for (const word of words) {
        if (word.length > maxChars) {
            if (line) { lines.push(line); line = ''; }
            for (let i = 0; i < word.length; i += maxChars) lines.push(word.slice(i, i + maxChars));
            continue;
        }
        const next = line ? `${line} ${word}` : word;
        if (next.length <= maxChars) line = next;
        else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
    return lines;
}

function imageDataUri(data, type) {
    if (!data) return null;
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!buffer.length) return null;
    const safeType = String(type || 'png').toLowerCase().replace(/[^a-z0-9.+-]/g, '') || 'png';
    return `data:image/${safeType};base64,${buffer.toString('base64')}`;
}

function svgDataUri(svg) {
    return `data:image/svg+xml;base64,${Buffer.from(String(svg || ''), 'utf8').toString('base64')}`;
}

function layoutFactory(width, baseFont) {
    const elements = [];
    const margin = 18;
    let y = 18;
    const usable = width - (margin * 2);
    const addText = (text, options = {}) => {
        const size = Number(options.size || baseFont);
        const weight = options.bold ? 700 : 400;
        const anchor = options.align === 'center' ? 'middle' : (options.align === 'right' ? 'end' : 'start');
        const x = options.align === 'center' ? width / 2 : (options.align === 'right' ? width - margin : margin);
        const lineHeight = Number(options.lineHeight || Math.ceil(size * 1.3));
        const maxChars = Number(options.maxChars || Math.max(10, Math.floor(usable / (size * 0.57))));
        const lines = options.wrap === false ? [String(text == null ? '' : text)] : wrapText(text, maxChars);
        for (const line of lines) {
            y += lineHeight;
            elements.push(`<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}">${escapeXml(line)}</text>`);
        }
        if (options.after) y += Number(options.after);
    };
    const addDivider = (options = {}) => {
        y += Number(options.before || 12);
        elements.push(`<line x1="${margin}" x2="${width - margin}" y1="${y}" y2="${y}" stroke="#000" stroke-width="2" stroke-dasharray="7 5"/>`);
        y += Number(options.after || 10);
    };
    const addImage = (uri, boxWidth, boxHeight) => {
        if (!uri) return;
        y += 8;
        elements.push(`<image href="${uri}" x="${Math.round((width - boxWidth) / 2)}" y="${y}" width="${boxWidth}" height="${boxHeight}" preserveAspectRatio="xMidYMid meet"/>`);
        y += boxHeight + 4;
    };
    const addRaw = (value) => elements.push(value);
    const advance = (value) => { y += Number(value || 0); };
    return { addText, addDivider, addImage, addRaw, advance, elements, getY: () => y, margin, usable };
}

function buildTicketSvg({ factura, detalles, pagos, negocio, mesaNumero, esCuenta = false, paperWidthMm = 58, fontSize = 1 }) {
    const width = Number(paperWidthMm || 58) <= 58 ? 384 : 576;
    const baseFont = Number(fontSize || 1) === 2 ? 27 : 23;
    const layout = layoutFactory(width, baseFont);
    const logo = imageDataUri(negocio?.logo_data, negocio?.logo_tipo);
    const qr = imageDataUri(negocio?.qr_data, negocio?.qr_tipo);
    const incluyeTransferencia = String(factura?.forma_pago || '').toLowerCase() === 'transferencia' ||
        (pagos || []).some(p => String(p?.metodo || '').toLowerCase() === 'transferencia');

    layout.addImage(logo, Math.min(210, width - 70), 100);
    layout.addText(negocio?.nombre_negocio || 'BISTRO CIENTO44', { align: 'center', bold: true, size: baseFont + 5 });
    if (negocio?.direccion) layout.addText(negocio.direccion, { align: 'center', size: baseFont - 3 });
    if (negocio?.telefono) layout.addText(`Tel: ${negocio.telefono}`, { align: 'center', size: baseFont - 3 });
    if (negocio?.nit) layout.addText(`R.F.C.: ${negocio.nit}`, { align: 'center', size: baseFont - 3 });
    layout.addDivider();
    layout.addText(`${esCuenta ? 'CUENTA' : 'Factura #'}: ${factura?.id ?? '-'}`, { bold: true });
    if (mesaNumero) layout.addText(`Mesa: ${mesaNumero}`, { bold: true });
    layout.addText(`Fecha: ${new Date(factura?.fecha || Date.now()).toLocaleString('es-MX')}`, { size: baseFont - 3 });
    layout.addDivider();

    (detalles || []).forEach((item) => {
        layout.addText(item?.producto_nombre || '', { bold: true, after: 2 });
        const y = layout.getY() + baseFont + 5;
        layout.addRaw(`<text x="${layout.margin}" y="${y}" font-size="${baseFont - 2}">${escapeXml(money(item?.cantidad))}</text>`);
        layout.addRaw(`<text x="${Math.round(width * 0.62)}" y="${y}" text-anchor="end" font-size="${baseFont - 2}">$${escapeXml(money(item?.precio_unitario))}</text>`);
        layout.addRaw(`<text x="${width - layout.margin}" y="${y}" text-anchor="end" font-size="${baseFont - 2}" font-weight="700">$${escapeXml(money(item?.subtotal))}</text>`);
        layout.advance(baseFont + 13);
    });

    layout.addDivider();
    layout.addText(`Total: $${money(factura?.total)}`, { align: 'right', bold: true, size: baseFont + 5, after: 6 });
    if (Array.isArray(pagos) && pagos.length) {
        layout.addText('Pagos:', { align: 'center', bold: true });
        pagos.forEach((pago) => {
            const metodo = String(pago?.metodo || '').trim();
            const ref = String(pago?.referencia || '').trim();
            layout.addText(`${metodo}: $${money(pago?.monto)}${ref ? ` (${ref})` : ''}`, { align: 'center', size: baseFont - 2 });
        });
    } else if (factura?.forma_pago) {
        layout.addText(`Forma de pago: ${factura.forma_pago}`, { align: 'center', size: baseFont - 2 });
    }
    if (qr && incluyeTransferencia) {
        layout.addText('Transferencia', { align: 'center', bold: true, after: 4 });
        layout.addImage(qr, 190, 190);
    }
    layout.addDivider();
    layout.addText(negocio?.pie_pagina || '¡Gracias por su compra!', { align: 'center', bold: true });
    layout.advance(95);

    const height = Math.ceil(layout.getY());
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#fff"/>
<g fill="#000" font-family="DejaVu Sans, Arial, sans-serif">${layout.elements.join('\n')}</g>
</svg>`;
    return { svg, width, height, dataUri: svgDataUri(svg) };
}

function buildComandaSvg({ pedido, items, negocio, area, paperWidthMm = 58, fontSize = 1 }) {
    const width = Number(paperWidthMm || 58) <= 58 ? 384 : 576;
    const baseFont = Number(fontSize || 1) === 2 ? 28 : 24;
    const layout = layoutFactory(width, baseFont);
    layout.addText(negocio || 'BISTRO CIENTO44', { align: 'center', bold: true, size: baseFont + 5 });
    layout.addDivider();
    const metaY = layout.getY() + baseFont + 12;
    layout.addRaw(`<text x="${layout.margin}" y="${metaY}" font-size="${baseFont - 4}">MESA</text>`);
    layout.addRaw(`<text x="${layout.margin}" y="${metaY + baseFont + 8}" font-size="${baseFont + 12}" font-weight="700">#${escapeXml(pedido?.mesa_numero ?? '-')}</text>`);
    layout.addRaw(`<text x="${width - layout.margin}" y="${metaY}" text-anchor="end" font-size="${baseFont - 4}">MESERO</text>`);
    layout.addRaw(`<text x="${width - layout.margin}" y="${metaY + baseFont + 8}" text-anchor="end" font-size="${baseFont}" font-weight="700">${escapeXml(pedido?.mesero_nombre || 'Sin asignar')}</text>`);
    layout.advance((baseFont * 2) + 25);
    layout.addText(`Pedido #${pedido?.id ?? '-'} · ${new Date().toLocaleString('es-MX')}`, { align: 'center', size: baseFont - 5 });
    layout.addDivider();
    layout.addText(area || 'COMANDA', { align: 'center', bold: true, size: baseFont + 7, after: 6 });

    (items || []).forEach((item) => {
        const qty = money(item?.cantidad);
        const nameLines = wrapText(item?.producto_nombre || '', Math.max(12, Math.floor((width - 105) / (baseFont * 0.58))));
        const noteLines = String(item?.nota || '').trim() ? wrapText(`⚠ ${item.nota}`, Math.max(12, Math.floor((width - 105) / ((baseFont - 4) * 0.58)))) : [];
        const rowHeight = Math.max(58, (nameLines.length * (baseFont + 4)) + (noteLines.length * baseFont) + 16);
        const top = layout.getY() + 8;
        layout.addRaw(`<rect x="${layout.margin}" y="${top}" width="64" height="44" rx="4" fill="#000"/>`);
        layout.addRaw(`<text x="${layout.margin + 32}" y="${top + 31}" text-anchor="middle" fill="#fff" font-size="${baseFont + 2}" font-weight="700">${escapeXml(qty)}</text>`);
        let textY = top + baseFont;
        nameLines.forEach(line => {
            layout.addRaw(`<text x="${layout.margin + 78}" y="${textY}" font-size="${baseFont}" font-weight="700">${escapeXml(line)}</text>`);
            textY += baseFont + 4;
        });
        noteLines.forEach(line => {
            layout.addRaw(`<text x="${layout.margin + 78}" y="${textY}" font-size="${baseFont - 4}" font-weight="700">${escapeXml(line)}</text>`);
            textY += baseFont;
        });
        layout.addRaw(`<line x1="${layout.margin}" x2="${width - layout.margin}" y1="${top + rowHeight}" y2="${top + rowHeight}" stroke="#777" stroke-width="1" stroke-dasharray="3 4"/>`);
        layout.advance(rowHeight + 10);
    });
    layout.addDivider();
    layout.addText('Fin de comanda', { align: 'center', bold: true });
    layout.advance(90);

    const height = Math.ceil(layout.getY());
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#fff"/>
<g fill="#000" font-family="DejaVu Sans, Arial, sans-serif">${layout.elements.join('\n')}</g>
</svg>`;
    return { svg, width, height, dataUri: svgDataUri(svg) };
}

function execFileBuffer(file, args, timeout = 30000) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout, encoding: null, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) return reject(new Error(String(stderr || error.message || `Error al ejecutar ${file}`)));
            resolve(stdout);
        });
    });
}

async function svgToEscPos(ticket) {
    if (process.platform === 'win32') throw new Error('La impresión raster ESC/POS requiere Linux/Raspberry');
    const tmpFile = path.join(os.tmpdir(), `ticket-${Date.now()}-${Math.random().toString(16).slice(2)}.svg`);
    fs.writeFileSync(tmpFile, ticket.svg, 'utf8');
    try {
        const pixels = await execFileBuffer('convert', [tmpFile, '-background', 'white', '-alpha', 'remove', '-colorspace', 'Gray', '-threshold', '68%', '-depth', '8', 'gray:-']);
        const expected = ticket.width * ticket.height;
        if (pixels.length < expected) throw new Error(`Raster incompleto: ${pixels.length}/${expected}`);
        const bytesPerRow = Math.ceil(ticket.width / 8);
        const chunks = [Buffer.from([0x1B, 0x40])];
        const rowsPerChunk = 256;
        for (let startY = 0; startY < ticket.height; startY += rowsPerChunk) {
            const rows = Math.min(rowsPerChunk, ticket.height - startY);
            const packed = Buffer.alloc(bytesPerRow * rows);
            for (let row = 0; row < rows; row += 1) {
                const sourceY = startY + row;
                for (let x = 0; x < ticket.width; x += 1) {
                    if (pixels[(sourceY * ticket.width) + x] < 128) {
                        packed[(row * bytesPerRow) + (x >> 3)] |= (0x80 >> (x & 7));
                    }
                }
            }
            chunks.push(Buffer.from([0x1D, 0x76, 0x30, 0x00, bytesPerRow & 0xFF, (bytesPerRow >> 8) & 0xFF, rows & 0xFF, (rows >> 8) & 0xFF]));
            chunks.push(packed);
        }
        chunks.push(Buffer.from([0x1B, 0x64, 0x06]));
        return Buffer.concat(chunks);
    } finally {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
}

async function queueRaw(data, printerName, jobPrefix = 'ticket') {
    const printer = resolvePrinterName(printerName);
    const tmpFile = path.join(os.tmpdir(), `${jobPrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
    fs.writeFileSync(tmpFile, data);
    try {
        const stdout = await execFileBuffer('lp', ['-d', printer, '-o', 'raw', '-o', 'job-sheets=none', tmpFile]);
        const output = stdout.toString('utf8').trim();
        const match = output.match(/request id is\s+([^\s]+)/i);
        return { printed: true, impresora: printer, job_id: match?.[1] || null, cups_message: output };
    } finally {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
}

async function printTicket(ticket, options = {}) {
    const key = String(options.dedupeKey || '').trim();
    const now = Date.now();
    for (const [storedKey, stored] of recentJobs.entries()) {
        if (now - stored.createdAt > DEDUPE_MS) recentJobs.delete(storedKey);
    }
    if (key && recentJobs.has(key)) {
        const previous = await recentJobs.get(key).promise;
        return { ...previous, duplicate_suppressed: true };
    }
    const promise = (async () => {
        const escpos = await svgToEscPos(ticket);
        return queueRaw(escpos, options.printerName, options.jobPrefix || 'ticket');
    })();
    if (key) recentJobs.set(key, { createdAt: now, promise });
    try {
        return await promise;
    } catch (error) {
        if (key) recentJobs.delete(key);
        throw error;
    }
}

module.exports = {
    buildComandaSvg,
    buildTicketSvg,
    printTicket,
    svgDataUri,
    svgToEscPos
};
