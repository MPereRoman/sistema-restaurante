const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');

const views = path.join(__dirname, '..', 'views');
const user = { usuario: 'admin', rol: 'administrador' };

test('renderiza la pantalla de gastos con histórico anual', async () => {
    const html = await ejs.renderFile(path.join(views, 'gastos.ejs'), {
        fechaHoy: '2026-11-16',
        user
    });
    assert.match(html, /Histórico semanal/);
    assert.match(html, /historicoTabla/);
});

test('renderiza la configuración con beneficiario bancario', async () => {
    const html = await ejs.renderFile(path.join(views, 'configuracion.ejs'), {
        config: {
            nombre_negocio: 'Bistro', ancho_papel: 80, font_size: 1,
            beneficiario_transferencia: 'María López'
        },
        user
    });
    assert.match(html, /name="beneficiario_transferencia"/);
    assert.match(html, /María López/);
});

test('el ticket muestra beneficiario y no muestra número de factura', async () => {
    const html = await ejs.renderFile(path.join(views, 'factura.ejs'), {
        factura: { id: 123, fecha: new Date('2026-11-16T18:00:00'), total: 100, forma_pago: 'transferencia' },
        detalles: [{ producto_nombre: 'Cold Brew', cantidad: 1, precio_unitario: 100, subtotal: 100 }],
        pagos: [{ metodo: 'transferencia', monto: 100, referencia: null }],
        config: {
            nombre_negocio: 'Bistro', ancho_papel: 80, font_size: 1,
            beneficiario_transferencia: 'María López', datos_transferencia: 'CLABE 0123'
        },
        es_cuenta: false,
        embed: false,
        return_to: '/ventas',
        mesa_numero: 2,
        ticket_svg_data_uri: null,
        user
    });
    assert.match(html, /Beneficiario:<\/strong> María López/);
    assert.doesNotMatch(html, /Factura #/);
});
