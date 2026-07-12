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
    } catch (err) {
        // No bloqueamos el arranque si falla el "auto-migrate", pero lo dejamos en consola.
        console.error('ensureSchema() falló:', err);
    }
}

// Verificar la conexión
pool.getConnection()
    .then(connection => {
        console.log('Conexión exitosa a la base de datos');
        connection.release();
        // Intentar asegurar esquema al iniciar (mejora compatibilidad al actualizar el sistema)
        ensureSchema();
    })
    .catch(err => {
        console.error('Error al conectar a la base de datos:', err);
    });

module.exports = pool; 
