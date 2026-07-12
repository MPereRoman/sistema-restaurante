const express = require('express');
const router = express.Router();
const db = require('../db');
let ExcelJS; // import perezoso para template/import

// GET /productos - Mostrar página de productos
router.get('/', async (req, res) => {
    try {
        const [productos] = await db.query('SELECT * FROM productos ORDER BY nombre');
        res.render('productos', { productos: productos || [] });
    } catch (error) {
        console.error('Error al obtener productos:', error);
        res.status(500).render('error', { 
            error: {
                message: 'Error al obtener productos',
                stack: error.stack
            }
        });
    }
});

// GET /productos/buscar - Buscar productos
router.get('/buscar', async (req, res) => {
    try {
        const query = req.query.q || '';
        const sql = `
            SELECT * FROM productos 
            WHERE nombre LIKE ? OR codigo LIKE ?
            ORDER BY nombre
            LIMIT 10
        `;
        const searchTerm = `%${query}%`;
        const [productos] = await db.query(sql, [searchTerm, searchTerm]);
        res.json(productos);
    } catch (error) {
        console.error('Error al buscar productos:', error);
        res.status(500).json({ error: 'Error al buscar productos' });
    }
});

// ============================
// Productos Hijos (Padre -> Hijos)
// Ejemplo: "CORRIENTE - Goulash de cerdo / Crema / Obs. Poco arroz"
// Relacionado con:
// - database.sql -> tabla producto_hijos
// - views/productos.ejs + public/js/productos.js (administración)
// - public/js/mesas.js (al montar pedido: selecciona hijos y los guarda en pedido_items.nota)
// ============================

// GET /productos/:padreId/hijos - Listar hijos de un producto padre
router.get('/:padreId(\\d+)/hijos', async (req, res) => {
    const padreId = Number(req.params.padreId);
    try {
        const [rows] = await db.query(`
            SELECT pr.id, pr.codigo, pr.nombre
            FROM producto_hijos ph
            JOIN productos pr ON pr.id = ph.producto_hijo_id
            WHERE ph.producto_padre_id = ?
            ORDER BY pr.nombre ASC
        `, [padreId]);
        res.json(rows || []);
    } catch (error) {
        console.error('Error al listar hijos del producto:', error);
        // Si la BD no está migrada aún, damos un error claro
        if (error && error.code === 'ER_NO_SUCH_TABLE') {
            return res.status(500).json({ error: 'Falta migración: cree la tabla producto_hijos (ver database.sql)' });
        }
        res.status(500).json({ error: 'Error al listar hijos del producto' });
    }
});

// POST /productos/:padreId/hijos - Agregar un hijo a un padre
router.post('/:padreId(\\d+)/hijos', async (req, res) => {
    const padreId = Number(req.params.padreId);
    const hijoId = Number(req.body?.producto_hijo_id);

    if (!Number.isFinite(padreId) || padreId <= 0) return res.status(400).json({ error: 'padreId inválido' });
    if (!Number.isFinite(hijoId) || hijoId <= 0) return res.status(400).json({ error: 'producto_hijo_id requerido' });
    if (padreId === hijoId) return res.status(400).json({ error: 'Un producto no puede ser hijo de sí mismo' });

    try {
        // Validar existencia de ambos productos (evita FK errors y mejora UX)
        const [[padre]] = await db.query('SELECT id FROM productos WHERE id = ? LIMIT 1', [padreId]);
        if (!padre) return res.status(404).json({ error: 'Producto padre no encontrado' });
        const [[hijo]] = await db.query('SELECT id FROM productos WHERE id = ? LIMIT 1', [hijoId]);
        if (!hijo) return res.status(404).json({ error: 'Producto hijo no encontrado' });

        // Insert idempotente (si ya existe, no rompe)
        await db.query(
            'INSERT IGNORE INTO producto_hijos (producto_padre_id, producto_hijo_id) VALUES (?, ?)',
            [padreId, hijoId]
        );

        res.status(201).json({ message: 'Hijo agregado' });
    } catch (error) {
        console.error('Error al agregar hijo al producto:', error);
        if (error && error.code === 'ER_NO_SUCH_TABLE') {
            return res.status(500).json({ error: 'Falta migración: cree la tabla producto_hijos (ver database.sql)' });
        }
        res.status(500).json({ error: 'Error al agregar hijo al producto' });
    }
});

// DELETE /productos/:padreId/hijos/:hijoId - Quitar un hijo de un padre
router.delete('/:padreId(\\d+)/hijos/:hijoId(\\d+)', async (req, res) => {
    const padreId = Number(req.params.padreId);
    const hijoId = Number(req.params.hijoId);
    try {
        const [result] = await db.query(
            'DELETE FROM producto_hijos WHERE producto_padre_id = ? AND producto_hijo_id = ?',
            [padreId, hijoId]
        );
        if ((result?.affectedRows || 0) === 0) {
            return res.status(404).json({ error: 'Relación no encontrada' });
        }
        res.json({ message: 'Hijo removido' });
    } catch (error) {
        console.error('Error al eliminar hijo del producto:', error);
        if (error && error.code === 'ER_NO_SUCH_TABLE') {
            return res.status(500).json({ error: 'Falta migración: cree la tabla producto_hijos (ver database.sql)' });
        }
        res.status(500).json({ error: 'Error al eliminar hijo del producto' });
    }
});

// ============================
// Hijos como "items" de texto (NO son productos)
// Ejemplo: Producto padre "CORRIENTE" -> items: "Goulash de cerdo", "Crema"
// Relacionado con:
// - database.sql -> tabla producto_hijos_items
// - views/productos.ejs + public/js/productos.js (administración de items)
// - public/js/mesas.js (montar pedido: selección múltiple y nota)
// ============================

// GET /productos/:padreId/hijos-items - Listar items hijos del producto padre
router.get('/:padreId(\\d+)/hijos-items', async (req, res) => {
    const padreId = Number(req.params.padreId);
    try {
        const [rows] = await db.query(`
            SELECT id, producto_padre_id, nombre, orden
            FROM producto_hijos_items
            WHERE producto_padre_id = ?
            ORDER BY orden ASC, nombre ASC, id ASC
        `, [padreId]);
        res.json(rows || []);
    } catch (error) {
        console.error('Error al listar hijos-items del producto:', error);
        if (error && error.code === 'ER_NO_SUCH_TABLE') {
            return res.status(500).json({ error: 'Falta migración: cree la tabla producto_hijos_items (ver database.sql)' });
        }
        res.status(500).json({ error: 'Error al listar hijos-items del producto' });
    }
});

// POST /productos/:padreId/hijos-items - Agregar item hijo (texto) al padre
router.post('/:padreId(\\d+)/hijos-items', async (req, res) => {
    const padreId = Number(req.params.padreId);
    const nombre = String(req.body?.nombre || '').trim();
    const orden = Number(req.body?.orden || 0);

    if (!Number.isFinite(padreId) || padreId <= 0) return res.status(400).json({ error: 'padreId inválido' });
    if (!nombre) return res.status(400).json({ error: 'nombre requerido' });
    if (nombre.length > 120) return res.status(400).json({ error: 'nombre demasiado largo (máx 120)' });

    try {
        const [[padre]] = await db.query('SELECT id FROM productos WHERE id = ? LIMIT 1', [padreId]);
        if (!padre) return res.status(404).json({ error: 'Producto padre no encontrado' });

        const [result] = await db.query(
            'INSERT IGNORE INTO producto_hijos_items (producto_padre_id, nombre, orden) VALUES (?, ?, ?)',
            [padreId, nombre, Number.isFinite(orden) ? orden : 0]
        );

        // Nota: INSERT IGNORE no informa duplicado; devolvemos 201 igual (idempotente)
        res.status(201).json({ id: result?.insertId || null, message: 'Item hijo agregado' });
    } catch (error) {
        console.error('Error al agregar hijo-item al producto:', error);
        if (error && error.code === 'ER_NO_SUCH_TABLE') {
            return res.status(500).json({ error: 'Falta migración: cree la tabla producto_hijos_items (ver database.sql)' });
        }
        res.status(500).json({ error: 'Error al agregar hijo-item al producto' });
    }
});

// DELETE /productos/:padreId/hijos-items/:itemId - Eliminar item hijo del padre
router.delete('/:padreId(\\d+)/hijos-items/:itemId(\\d+)', async (req, res) => {
    const padreId = Number(req.params.padreId);
    const itemId = Number(req.params.itemId);
    try {
        const [result] = await db.query(
            'DELETE FROM producto_hijos_items WHERE id = ? AND producto_padre_id = ?',
            [itemId, padreId]
        );
        if ((result?.affectedRows || 0) === 0) return res.status(404).json({ error: 'Item hijo no encontrado' });
        res.json({ message: 'Item hijo eliminado' });
    } catch (error) {
        console.error('Error al eliminar hijo-item del producto:', error);
        if (error && error.code === 'ER_NO_SUCH_TABLE') {
            return res.status(500).json({ error: 'Falta migración: cree la tabla producto_hijos_items (ver database.sql)' });
        }
        res.status(500).json({ error: 'Error al eliminar hijo-item del producto' });
    }
});

// GET /productos/:id - Obtener un producto específico
router.get('/:id(\\d+)', async (req, res) => {
    try {
        const [productos] = await db.query('SELECT * FROM productos WHERE id = ?', [req.params.id]);
        const producto = productos[0];
        if (!producto) {
            return res.status(404).json({ error: 'Producto no encontrado' });
        }
        res.json(producto);
    } catch (error) {
        console.error('Error al obtener producto:', error);
        res.status(500).json({ error: 'Error al obtener producto' });
    }
});

// POST /productos - Crear nuevo producto
router.post('/', async (req, res) => {
    try {
        const { codigo, nombre, precio_kg, precio_unidad, precio_libra } = req.body;
        
        // Validar datos
        if (!codigo || !nombre) {
            return res.status(400).json({ error: 'El código y nombre son requeridos' });
        }

        const result = await db.query(
            'INSERT INTO productos (codigo, nombre, precio_kg, precio_unidad, precio_libra) VALUES (?, ?, ?, ?, ?)',
            [codigo, nombre, precio_kg || 0, precio_unidad || 0, precio_libra || 0]
        );

        res.status(201).json({ 
            id: result.insertId,
            message: 'Producto creado exitosamente' 
        });
    } catch (error) {
        console.error('Error al crear producto:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Ya existe un producto con ese código' });
        }
        res.status(500).json({ error: 'Error al crear producto' });
    }
});

// PUT /productos/:id - Actualizar producto
router.put('/:id', async (req, res) => {
    try {
        const { codigo, nombre, precio_kg, precio_unidad, precio_libra } = req.body;
        
        // Validar datos
        if (!codigo || !nombre) {
            return res.status(400).json({ error: 'El código y nombre son requeridos' });
        }

        const result = await db.query(
            'UPDATE productos SET codigo = ?, nombre = ?, precio_kg = ?, precio_unidad = ?, precio_libra = ? WHERE id = ?',
            [codigo, nombre, precio_kg || 0, precio_unidad || 0, precio_libra || 0, req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Producto no encontrado' });
        }

        res.json({ message: 'Producto actualizado exitosamente' });
    } catch (error) {
        console.error('Error al actualizar producto:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Ya existe un producto con ese código' });
        }
        res.status(500).json({ error: 'Error al actualizar producto' });
    }
});

// DELETE /productos/:id - Eliminar producto
router.delete('/:id', async (req, res) => {
    try {
        const result = await db.query('DELETE FROM productos WHERE id = ?', [req.params.id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Producto no encontrado' });
        }

        res.json({ message: 'Producto eliminado exitosamente' });
    } catch (error) {
        console.error('Error al eliminar producto:', error);
        res.status(500).json({ error: 'Error al eliminar producto' });
    }
});

module.exports = router; 

// Rutas adicionales para import/export masivo - se montan en el mismo archivo
router.get('/plantilla', async (req, res) => {
    try {
        try { ExcelJS = ExcelJS || require('exceljs'); } catch (e) { return res.status(500).send('Instale exceljs para generar la plantilla'); }

        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Instrucciones');
        ws.addRow(['PLANTILLA DE PRODUCTOS']).font = { bold: true, size: 16 };
        ws.addRow(['1) No cambie los encabezados de la hoja "Productos".']).font = { color: { argb: 'FF495057' } };
        ws.addRow(['2) Columnas obligatorias: codigo, nombre. Los precios pueden ser 0.']).font = { color: { argb: 'FF495057' } };
        ws.addRow(['3) Use punto como decimal (ej: 1234.56).']).font = { color: { argb: 'FF495057' } };
        ws.addRow(['4) El código debe ser único. Si ya existe, se actualizarán precios/nombre.']).font = { color: { argb: 'FF495057' } };
        ws.getColumn(1).width = 80;
        ws.addRow([]);

        const table = wb.addWorksheet('Productos');
        table.columns = [
            { header: 'codigo', key: 'codigo', width: 18 },
            { header: 'nombre', key: 'nombre', width: 32 },
            { header: 'precio_unidad', key: 'precio_unidad', width: 16 }
        ];
        const headerRow = table.getRow(1);
        headerRow.font = { bold: true };
        headerRow.alignment = { horizontal: 'center' };
        headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9ECEF' } };
        table.views = [{ state: 'frozen', ySplit: 1 }];

        // Ejemplos
        table.addRow({ codigo: 'P001', nombre: 'Café americano', precio_unidad: 55 });
        table.addRow({ codigo: 'P002', nombre: 'Croissant', precio_unidad: 48 });
        table.addRow({ codigo: 'P003', nombre: 'Té helado', precio_unidad: 45 });

        // Validaciones (toda la columna a partir de fila 2)
        table.dataValidations.add('A2:A1048576', { type: 'textLength', operator: 'greaterThan', formulae: [0], allowBlank: false, showErrorMessage: true, errorTitle: 'Código requerido', error: 'Ingrese un código' });
        table.dataValidations.add('B2:B1048576', { type: 'textLength', operator: 'greaterThan', formulae: [0], allowBlank: false, showErrorMessage: true, errorTitle: 'Nombre requerido', error: 'Ingrese el nombre' });
        ['C'].forEach(col => {
            table.dataValidations.add(`${col}2:${col}1048576`, { type: 'decimal', operator: 'greaterThanOrEqual', formulae: [0], allowBlank: true, showErrorMessage: true, errorTitle: 'Precio inválido', error: 'Debe ser número ≥ 0 (use punto decimal)' });
        });

        res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition','attachment; filename="plantilla_productos.xlsx"');
        await wb.xlsx.write(res); res.end();
    } catch (e) { console.error(e); res.status(500).send('No se pudo generar la plantilla'); }
});

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5*1024*1024 } });

router.post('/importar', upload.single('archivo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
        try { ExcelJS = ExcelJS || require('exceljs'); } catch (e) { return res.status(500).json({ error: 'Instale exceljs para importar' }); }

        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(req.file.buffer);
        const ws = wb.getWorksheet('Productos') || wb.worksheets[0];
        if (!ws) return res.status(400).json({ error: 'Hoja Productos no encontrada' });

        const header = ['codigo','nombre','precio_unidad'];
        const colIdx = header.map((h,i)=> i+1);
        const rows = [];
        ws.eachRow((row, idx) => {
            if (idx === 1) return; // encabezado
            const r = header.reduce((acc, key, i) => { acc[key] = row.getCell(i+1).value || ''; return acc; }, {});
            if (!r.codigo || !r.nombre) return;
            rows.push({
                codigo: String(r.codigo).trim(),
                nombre: String(r.nombre).trim(),
                precio_unidad: Number(r.precio_unidad||0)
            });
        });

        if (rows.length === 0) return res.status(400).json({ error: 'No hay registros válidos' });

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            for (const p of rows) {
                await connection.query(
                    'INSERT INTO productos (codigo, nombre, precio_kg, precio_unidad, precio_libra) VALUES (?,?,0,?,0) ON DUPLICATE KEY UPDATE nombre=VALUES(nombre), precio_unidad=VALUES(precio_unidad)',
                    [p.codigo, p.nombre, p.precio_unidad]
                );
            }
            await connection.commit();
        } catch (e) { await connection.rollback(); throw e; }
        finally { connection.release(); }

        res.json({ inserted: rows.length });
    } catch (e) {
        console.error('Error al importar:', e);
        res.status(500).json({ error: 'Error al importar productos' });
    }
});
