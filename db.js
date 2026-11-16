const mysql = require('mysql2');

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'reconocimiento',
    connectionLimit: 10,
    waitForConnections: true,
    queueLimit: 0
}).promise();

/**
 * Asegura el esquema mínimo requerido para nuevas funcionalidades (sin romper instalaciones existentes).
 * - Crea tabla factura_pagos (1 factura -> N pagos)
 * - Amplía ENUM facturas.forma_pago para soportar tarjeta/mixto
 *
 * Relacionado con:
 * - routes/facturas.js (facturación desde index)
 * - routes/mesas.js (facturación desde mesas)
 * - views/factura.ejs (impresión)
 */
async function ensureSchema() {
    try {
        // Datos operativos de Bistro Ciento44. Las columnas se agregan de forma
        // compatible para instalaciones existentes, sin tocar el historial.
        await pool.query(`ALTER TABLE mesas ADD COLUMN IF NOT EXISTS activa TINYINT(1) NOT NULL DEFAULT 1 AFTER estado`);
        await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS numero_personas INT NOT NULL DEFAULT 1 AFTER mesero_nombre`);
        await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pagos_borrador LONGTEXT NULL AFTER numero_personas`);
        await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cierre_automatico TINYINT(1) NOT NULL DEFAULT 0 AFTER pagos_borrador`);
        await pool.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cerrado_at DATETIME NULL AFTER cierre_automatico`);
        await pool.query(`ALTER TABLE facturas ADD COLUMN IF NOT EXISTS pedido_id INT NULL AFTER cliente_id`);
        await pool.query(`ALTER TABLE facturas ADD COLUMN IF NOT EXISTS estado ENUM('borrador','pagada') NOT NULL DEFAULT 'pagada' AFTER forma_pago`);

        const [facturaPedidoIndexes] = await pool.query(
            `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'facturas'
               AND INDEX_NAME = 'uq_facturas_pedido'
             LIMIT 1`
        );
        if (!facturaPedidoIndexes.length) {
            await pool.query(`ALTER TABLE facturas ADD UNIQUE KEY uq_facturas_pedido (pedido_id)`);
        }

        const [rolCols] = await pool.query(
            `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND COLUMN_NAME = 'rol'
             LIMIT 1`
        );
        const rolType = String(rolCols?.[0]?.COLUMN_TYPE || '');
        if (rolType && !rolType.includes("'barman'")) {
            await pool.query(
                `ALTER TABLE usuarios
                 MODIFY rol ENUM('administrador','mesero','cocinero','barman') NOT NULL DEFAULT 'mesero'`
            );
        }

        const [categoriaCols] = await pool.query(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productos' AND COLUMN_NAME = 'tipo_preparacion'`
        );
        const categoriaNueva = !categoriaCols.length;
        await pool.query(
            `ALTER TABLE productos ADD COLUMN IF NOT EXISTS tipo_preparacion ENUM('alimento','bebida') NOT NULL DEFAULT 'alimento' AFTER nombre`
        );
        await pool.query(
            `ALTER TABLE productos ADD COLUMN IF NOT EXISTS activo TINYINT(1) NOT NULL DEFAULT 1 AFTER precio_libra`
        );
        await pool.query(
            `ALTER TABLE producto_hijos_items ADD COLUMN IF NOT EXISTS costo_extra DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER nombre`
        );
        if (categoriaNueva) {
            await pool.query(
                `UPDATE productos SET tipo_preparacion = 'bebida'
                 WHERE UPPER(codigo) IN ('CAFE','CHOC','REFR','TEFR')
                    OR LOWER(TRIM(nombre)) REGEXP '^(cafe|café|chocolate|refresco|te|té|agua|jugo|bebida|licuado)( |$)'`
            );
        }

        await pool.query(
            `ALTER TABLE configuracion_impresion
             ADD COLUMN IF NOT EXISTS impresora_comandas_barra VARCHAR(150) NULL AFTER impresora_comandas`
        );
        const [barraAutoListoCols] = await pool.query(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'configuracion_impresion'
               AND COLUMN_NAME = 'barra_auto_listo_comanda'`
        );
        const barraAutoListoNueva = !barraAutoListoCols.length;
        await pool.query(
            `ALTER TABLE configuracion_impresion
             ADD COLUMN IF NOT EXISTS barra_auto_listo_comanda TINYINT(1) NOT NULL DEFAULT 0 AFTER cocina_auto_listo_comanda`
        );
        if (barraAutoListoNueva) {
            // La opción anterior era compartida: al migrar, conservar su valor en ambas áreas.
            await pool.query(
                `UPDATE configuracion_impresion
                 SET barra_auto_listo_comanda = cocina_auto_listo_comanda`
            );
        }
        await pool.query(
            `ALTER TABLE configuracion_impresion
             ADD COLUMN IF NOT EXISTS datos_transferencia VARCHAR(255) NULL AFTER pie_pagina`
        );
        await pool.query(
            `ALTER TABLE configuracion_impresion
             ADD COLUMN IF NOT EXISTS beneficiario_transferencia VARCHAR(150) NULL AFTER datos_transferencia`
        );

        // Tabla de pagos por factura (pago mixto) — con soporte para QR
        await pool.query(`
            CREATE TABLE IF NOT EXISTS factura_pagos (
                id INT AUTO_INCREMENT PRIMARY KEY,
                factura_id INT NOT NULL,
                metodo ENUM('efectivo', 'transferencia', 'tarjeta', 'qr') NOT NULL,
                monto DECIMAL(10,2) NOT NULL,
                referencia VARCHAR(100) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (factura_id) REFERENCES facturas(id) ON DELETE CASCADE
            )
        `);

        // Migrar facturas.forma_pago: asegurar que incluya tarjeta, qr y mixto
        const [rowsFP] = await pool.query(
            `SELECT COLUMN_TYPE
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'facturas'
               AND COLUMN_NAME = 'forma_pago'
             LIMIT 1`
        );
        const fpType = rowsFP?.[0]?.COLUMN_TYPE || '';
        if (fpType && (!fpType.includes("'tarjeta'") || !fpType.includes("'qr'") || !fpType.includes("'mixto'"))) {
            await pool.query(
                `ALTER TABLE facturas
                 MODIFY forma_pago ENUM('efectivo','transferencia','tarjeta','qr','mixto') NOT NULL DEFAULT 'efectivo'`
            );
        }

        // Migrar factura_pagos.metodo: asegurar que incluya qr
        const [rowsMP] = await pool.query(
            `SELECT COLUMN_TYPE
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'factura_pagos'
               AND COLUMN_NAME = 'metodo'
             LIMIT 1`
        );
        const mpType = rowsMP?.[0]?.COLUMN_TYPE || '';
        if (mpType && !mpType.includes("'qr'")) {
            await pool.query(
                `ALTER TABLE factura_pagos
                 MODIFY metodo ENUM('efectivo','transferencia','tarjeta','qr') NOT NULL`
            );
        }

        await pool.query(`
            CREATE TABLE IF NOT EXISTS gastos (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                fecha DATE NOT NULL,
                concepto VARCHAR(200) NOT NULL,
                total DECIMAL(12,2) NOT NULL,
                metodo_pago ENUM('efectivo','transferencia','tarjeta','otro') NOT NULL DEFAULT 'efectivo',
                creado_por_id INT NULL,
                creado_por_nombre VARCHAR(100) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_gastos_fecha (fecha)
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS fondos_caja (
                fecha DATE PRIMARY KEY,
                monto DECIMAL(12,2) NOT NULL DEFAULT 0,
                creado_por_id INT NULL,
                creado_por_nombre VARCHAR(100) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS cortes_diarios (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                fecha DATE NOT NULL,
                numero_facturas INT NOT NULL DEFAULT 0,
                total_efectivo DECIMAL(12,2) NOT NULL DEFAULT 0,
                total_transferencia DECIMAL(12,2) NOT NULL DEFAULT 0,
                total_tarjeta DECIMAL(12,2) NOT NULL DEFAULT 0,
                total_qr DECIMAL(12,2) NOT NULL DEFAULT 0,
                total_ventas DECIMAL(12,2) NOT NULL DEFAULT 0,
                total_gastos DECIMAL(12,2) NOT NULL DEFAULT 0,
                gastos_efectivo DECIMAL(12,2) NOT NULL DEFAULT 0,
                fondo_caja DECIMAL(12,2) NOT NULL DEFAULT 0,
                resultado_operativo DECIMAL(12,2) NOT NULL DEFAULT 0,
                saldo_caja_estimado DECIMAL(12,2) NOT NULL DEFAULT 0,
                primera_venta DATETIME NULL,
                ultima_venta DATETIME NULL,
                creado_por_id INT NULL,
                creado_por_nombre VARCHAR(100) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_cortes_fecha (fecha)
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS resumenes_semanales (
                semana_inicio DATE PRIMARY KEY,
                semana_fin DATE NOT NULL,
                anio SMALLINT NOT NULL,
                numero_semana TINYINT NOT NULL,
                neto DECIMAL(14,2) NOT NULL DEFAULT 0,
                archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_resumenes_anio (anio, semana_inicio)
            )
        `);
    } catch (err) {
        // No bloqueamos el arranque si falla el "auto-migrate", pero lo dejamos en consola.
        console.error('ensureSchema() falló:', err);
    }
}

module.exports = pool; 
module.exports.ensureSchema = ensureSchema;
