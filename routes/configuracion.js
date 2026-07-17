const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const os = require('os');
const { exec } = require('child_process');
const QRCode = require('qrcode');
const { openCashDrawer, printText, resolvePrinterName } = require('../services/printer');

// Configuración de multer para memoria
const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter: function (req, file, cb) {
        if (!file.originalname.match(/\.(jpg|jpeg|png|gif)$/)) {
            return cb(new Error('Solo se permiten imágenes'));
        }
        cb(null, true);
    }
});

// Función para verificar y crear configuración inicial
async function verificarConfiguracion() {
    try {
        const [config] = await db.query('SELECT * FROM configuracion_impresion LIMIT 1');
        
        if (!config || config.length === 0) {
            // Crear configuración inicial
            await db.query(`
                INSERT INTO configuracion_impresion 
                (nombre_negocio, direccion, telefono, pie_pagina) 
                VALUES 
                ('Mi Negocio', 'Dirección del Negocio', 'Teléfono', '¡Gracias por su compra!')
            `);
            console.log('Configuración inicial creada');
        }
    } catch (error) {
        console.error('Error al verificar configuración:', error);
    }
}

// Verificar configuración al iniciar
verificarConfiguracion();

// Obtener configuración
router.get('/', async (req, res) => {
    try {
        const [config] = await db.query('SELECT * FROM configuracion_impresion LIMIT 1');
        
        if (!config || config.length === 0) {
            // Si no hay configuración, renderizar la vista con valores por defecto
            return res.render('configuracion', { 
                config: {
                    nombre_negocio: '',
                    direccion: '',
                    telefono: '',
                    nit: '',
                    pie_pagina: '',
                    ancho_papel: 80,
                    font_size: 1,
                    cocina_auto_listo_comanda: 0,
                    cocina_imprime_servidor: 0,
                    impresora_comandas: '',
                    impresora_comandas_barra: '',
                    impresora_facturas: '',
                    factura_imprime_servidor: 0,
                    factura_copias: 1,
                    factura_auto_print: 0,
                    // Previsualizadores (vacíos en configuración por defecto)
                    logo_src: null,
                    qr_src: null
                }
            });
        }

        // Construir previsualización (data URL) si ya hay logo/QR guardados
        // Relacionado con: views/configuracion.ejs (muestra "Logo actual" y "QR actual")
        const configSinImagenes = { ...config[0] };
        if (configSinImagenes.logo_data) {
            try {
                const logoBuffer = Buffer.from(configSinImagenes.logo_data);
                const tipo = configSinImagenes.logo_tipo || 'png';
                configSinImagenes.logo_src = `data:image/${tipo};base64,${logoBuffer.toString('base64')}`;
            } catch (_) {
                configSinImagenes.logo_src = null;
            }
        } else {
            configSinImagenes.logo_src = null;
        }
        if (configSinImagenes.qr_data) {
            try {
                const qrBuffer = Buffer.from(configSinImagenes.qr_data);
                const tipo = configSinImagenes.qr_tipo || 'png';
                configSinImagenes.qr_src = `data:image/${tipo};base64,${qrBuffer.toString('base64')}`;
            } catch (_) {
                configSinImagenes.qr_src = null;
            }
        } else {
            configSinImagenes.qr_src = null;
        }

        // No enviar los datos binarios de las imágenes a la vista (solo logo_src/qr_src)
        delete configSinImagenes.logo_data;
        delete configSinImagenes.qr_data;

        res.render('configuracion', { config: configSinImagenes });
    } catch (error) {
        console.error('Error al obtener configuración:', error);
        res.status(500).json({ error: 'Error al obtener configuración' });
    }
});

// Guardar configuración
router.post('/', upload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'qr', maxCount: 1 }
]), async (req, res) => {
    try {
        const {
            nombre_negocio,
            direccion,
            telefono,
            nit,
            pie_pagina,
            ancho_papel,
            font_size,
            cocina_auto_listo_comanda,
            cocina_imprime_servidor,
            impresora_comandas,
            impresora_comandas_barra,
            impresora_facturas,
            factura_imprime_servidor,
            factura_copias,
            factura_auto_print
        } = req.body;

        const [results] = await db.query('SELECT * FROM configuracion_impresion LIMIT 1');

        let values = [
            nombre_negocio,
            direccion || null,
            telefono || null,
            nit || null,
            pie_pagina || null,
            ancho_papel || 80,
            font_size || 1,
            Number(String(cocina_auto_listo_comanda || '0')) ? 1 : 0,
            Number(String(cocina_imprime_servidor || '0')) ? 1 : 0,
            String(impresora_comandas || '').trim() || null,
            String(impresora_comandas_barra || '').trim() || null,
            String(impresora_facturas || '').trim() || null,
            Number(String(factura_imprime_servidor || '0')) ? 1 : 0,
            Math.max(1, Number(factura_copias || 1) || 1),
            Number(String(factura_auto_print || '0')) ? 1 : 0
        ];

        // Agregar datos de imágenes si se subieron nuevas
        if (req.files?.logo) {
            values.push(req.files.logo[0].buffer);
            values.push(req.files.logo[0].mimetype.split('/')[1]);
        }
        if (req.files?.qr) {
            values.push(req.files.qr[0].buffer);
            values.push(req.files.qr[0].mimetype.split('/')[1]);
        }

        if (!results || results.length === 0) {
            // Insertar nueva configuración
            let sql = `
                INSERT INTO configuracion_impresion 
                (nombre_negocio, direccion, telefono, nit, pie_pagina, 
                 ancho_papel, font_size, cocina_auto_listo_comanda, cocina_imprime_servidor,
                 impresora_comandas, impresora_comandas_barra, impresora_facturas, factura_imprime_servidor, factura_copias, factura_auto_print
            `;
            if (req.files?.logo) sql += ', logo_data, logo_tipo';
            if (req.files?.qr) sql += ', qr_data, qr_tipo';
            sql += ') VALUES (' + values.map(() => '?').join(',') + ')';
            
            await db.query(sql, values);
        } else {
            // Actualizar configuración existente
            let sql = `
                UPDATE configuracion_impresion 
                SET nombre_negocio = ?, direccion = ?, telefono = ?, nit = ?,
                    pie_pagina = ?, ancho_papel = ?, font_size = ?, cocina_auto_listo_comanda = ?, cocina_imprime_servidor = ?,
                    impresora_comandas = ?, impresora_comandas_barra = ?, impresora_facturas = ?, factura_imprime_servidor = ?, factura_copias = ?, factura_auto_print = ?
            `;
            if (req.files?.logo) sql += ', logo_data = ?, logo_tipo = ?';
            if (req.files?.qr) sql += ', qr_data = ?, qr_tipo = ?';
            sql += ' WHERE id = ?';
            
            values.push(results[0].id);
            
            await db.query(sql, values);
        }

        res.redirect('/configuracion');
    } catch (error) {
        console.error('Error en el procesamiento:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Obtener impresoras instaladas del sistema (Windows / Linux / macOS)
// Nota: en navegador no se puede forzar impresora, esto funciona como preferencia referencial.
router.get('/impresoras', (req, res) => {
    const platform = String(process.platform || '').toLowerCase();

    const parseLines = (out) => String(out || '')
        .split(/\r?\n/)
        .map((x) => String(x || '').trim())
        .filter(Boolean);

    let cmd = '';
    if (platform === 'win32') {
        cmd = 'powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"';
    } else if (platform === 'darwin') {
        cmd = "lpstat -a | awk '{print $1}'";
    } else {
        cmd = "lpstat -a | awk '{print $1}'";
    }

    exec(cmd, { timeout: 5000 }, (error, stdout) => {
        if (error) return res.json([]);
        const impresoras = parseLines(stdout);
        res.json([...new Set(impresoras)]);
    });
});

// POST /configuracion/impresion/comanda-prueba
// Imprime una comanda de prueba desde el servidor (PC), sin navegador móvil.
router.post('/impresion/comanda-prueba', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT nombre_negocio, impresora_comandas, impresora_comandas_barra, ancho_papel, font_size FROM configuracion_impresion LIMIT 1');
        const cfg       = rows?.[0] || {};
        const negocio   = String(cfg?.nombre_negocio || 'MI NEGOCIO');
        const area       = String(req.body?.area || 'alimento').toLowerCase() === 'bebida' ? 'bebida' : 'alimento';
        const impresora = resolvePrinterName(
            area === 'bebida'
                ? (cfg?.impresora_comandas_barra || cfg?.impresora_comandas)
                : cfg?.impresora_comandas
        );
        const anchoPapel = Number(cfg?.ancho_papel || 80);
        const fontSize   = Number(cfg?.font_size   || 1);

        const line = '-'.repeat(42);
        const texto = [
            negocio,
            line,
            `COMANDA DE PRUEBA · ${area === 'bebida' ? 'BARRA' : 'COCINA'}`,
            `Fecha: ${new Date().toLocaleString('es-CO')}`,
            'Mesa: 1',
            'Mesero: Prueba',
            line,
            'x1 Producto de prueba',
            '  Obs: Sin cebolla',
            line,
            'Fin de prueba'
        ].join('\r\n');

        await printText(texto, {
            printerName: impresora,
            paperWidthMm: anchoPapel,
            fontSize,
            bold: true,
            jobPrefix: 'comanda-prueba'
        });
        res.json({ ok: true, impresora });
    } catch (error) {
        console.error('Error al imprimir comanda de prueba:', error);
        res.status(500).json({ error: 'No se pudo imprimir la comanda de prueba en servidor' });
    }
});

// ===== Vinculación de dispositivos (QR + diagnóstico) =====
// Relacionado con:
// - views/configuracion.ejs (apartado "Vincular dispositivos")
// - middleware/auth.js + server.js (solo administrador accede a esta sección)

router.post('/impresion/cajon-prueba', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT impresora_facturas FROM configuracion_impresion LIMIT 1');
        const impresora = resolvePrinterName(rows?.[0]?.impresora_facturas);
        await openCashDrawer(impresora);
        res.json({ ok: true, impresora });
    } catch (error) {
        console.error('Error al abrir cajón de prueba:', error);
        res.status(500).json({ error: 'No se pudo abrir el cajón' });
    }
});

function getIpv4Locales() {
    // Obtiene IPs IPv4 válidas para LAN (evita loopback/internas no útiles)
    const nets = os.networkInterfaces();
    const ips = [];
    Object.values(nets || {}).forEach((ifaces) => {
        (ifaces || []).forEach((addr) => {
            if (!addr) return;
            const family = String(addr.family || '').toLowerCase();
            const isIpv4 = (family === 'ipv4' || String(addr.family) === '4');
            if (!isIpv4) return;
            if (addr.internal) return;
            const ip = String(addr.address || '').trim();
            if (!ip) return;
            ips.push(ip);
        });
    });
    return [...new Set(ips)];
}

function getPortFromRequest(req) {
    // Toma el puerto desde Host (ej: 192.168.1.10:3002), con fallback a PORT del proceso.
    const hostHeader = String(req.get('host') || '').trim();
    const hostParts = hostHeader.split(':');
    if (hostParts.length >= 2) {
        const p = Number(hostParts[hostParts.length - 1]);
        if (Number.isFinite(p) && p > 0) return p;
    }
    const envPort = Number(process.env.PORT || 3002);
    return Number.isFinite(envPort) && envPort > 0 ? envPort : 3002;
}

function buildCandidateUrls(req) {
    const port = getPortFromRequest(req);
    const protocol = String(req.protocol || 'http').toLowerCase();
    const urls = [];

    // URL principal local
    urls.push(`${protocol}://localhost:${port}`);

    // URLs LAN por IP (las que se comparten con celulares/tablets de la misma red)
    getIpv4Locales().forEach((ip) => {
        urls.push(`${protocol}://${ip}:${port}`);
    });

    return [...new Set(urls)];
}

function guessPreferredUrl(req) {
    // Preferimos una IP LAN si existe (más útil para vincular dispositivos);
    // si no, dejamos localhost.
    const urls = buildCandidateUrls(req);
    const lanUrl = urls.find((u) => !u.includes('localhost'));
    return lanUrl || urls[0] || null;
}

async function runConnectionDiagnostics(req, targetUrl) {
    const diagnostics = {
        timestamp: new Date().toISOString(),
        db_ok: false,
        server_http_ok: false,
        server_http_status: null,
        server_http_error: null,
        puerto: getPortFromRequest(req),
        host_header: String(req.get('host') || ''),
        recommended_url: guessPreferredUrl(req),
        ips_locales: getIpv4Locales(),
        posibles_causas: [],
        recomendaciones: []
    };

    // 1) Diagnóstico DB (si esto falla, el sistema puede parecer "caído")
    try {
        const [rows] = await db.query('SELECT 1 AS ok');
        diagnostics.db_ok = Boolean(rows && rows[0] && Number(rows[0].ok) === 1);
    } catch (e) {
        diagnostics.db_ok = false;
        diagnostics.posibles_causas.push('La base de datos no está respondiendo.');
        diagnostics.recomendaciones.push('Verifica que MySQL esté iniciado y que las credenciales de conexión sean correctas.');
    }

    // 2) Diagnóstico HTTP local al URL objetivo
    const safeTarget = String(targetUrl || '').trim() || diagnostics.recommended_url;
    if (!safeTarget) {
        diagnostics.posibles_causas.push('No se pudo construir una URL válida para pruebas de conexión.');
        diagnostics.recomendaciones.push('Revisa IP/puerto del servidor y vuelve a generar el QR.');
        return diagnostics;
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const response = await fetch(safeTarget, {
            method: 'GET',
            signal: controller.signal,
            redirect: 'follow'
        });
        clearTimeout(timeout);
        diagnostics.server_http_ok = response.ok || response.status === 302 || response.status === 401 || response.status === 403;
        diagnostics.server_http_status = response.status;
        if (!diagnostics.server_http_ok) {
            diagnostics.posibles_causas.push(`El servidor respondió con estado HTTP ${response.status}.`);
        }
    } catch (e) {
        diagnostics.server_http_ok = false;
        diagnostics.server_http_error = String(e && e.message ? e.message : e);
        diagnostics.posibles_causas.push('No fue posible abrir el servidor por HTTP desde esta máquina.');
        diagnostics.recomendaciones.push('Confirma que la app esté encendida y escuchando en el puerto configurado.');
        diagnostics.recomendaciones.push('Si otros dispositivos no conectan, revisa firewall de Windows y permite Node.js en red privada.');
    }

    // 3) Reglas prácticas para red local
    if ((diagnostics.ips_locales || []).length === 0) {
        diagnostics.posibles_causas.push('No se detectaron IPs LAN en este equipo.');
        diagnostics.recomendaciones.push('Conecta el servidor a WiFi/LAN y evita usar solo localhost.');
    } else {
        diagnostics.recomendaciones.push('Asegura que el dispositivo cliente y el servidor estén en la misma red WiFi/LAN.');
    }
    diagnostics.recomendaciones.push(`Si el cliente no abre la página, prueba manualmente: ${safeTarget}`);

    return diagnostics;
}

// GET /configuracion/conexion-info
// Devuelve URLs candidatas + QR base64 de la URL recomendada.
router.get('/conexion-info', async (req, res) => {
    try {
        const urls = buildCandidateUrls(req);
        const preferred = guessPreferredUrl(req);
        let qr_data_url = null;

        if (preferred) {
            qr_data_url = await QRCode.toDataURL(preferred, {
                errorCorrectionLevel: 'M',
                margin: 1,
                width: 280
            });
        }

        res.json({
            host_header: String(req.get('host') || ''),
            puerto: getPortFromRequest(req),
            ips_locales: getIpv4Locales(),
            urls,
            preferred_url: preferred,
            qr_data_url: qr_data_url
        });
    } catch (error) {
        console.error('Error al generar info de conexión:', error);
        res.status(500).json({ error: 'No se pudo generar la información de conexión' });
    }
});

// GET /configuracion/diagnostico?target_url=http://192.168.1.10:3002
// Ejecuta diagnóstico de conectividad y devuelve causas/recomendaciones.
router.get('/diagnostico', async (req, res) => {
    try {
        const target_url = String(req.query.target_url || '').trim();
        const diagnostics = await runConnectionDiagnostics(req, target_url);
        res.json(diagnostics);
    } catch (error) {
        console.error('Error al diagnosticar conexión:', error);
        res.status(500).json({ error: 'No se pudo ejecutar el diagnóstico de conexión' });
    }
});

module.exports = router;
