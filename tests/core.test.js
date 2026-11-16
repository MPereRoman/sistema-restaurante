const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getRetentionCutoff, getWeekArchiveMetadata, archiveExpiredWeeklySummaries } = require('../services/retention');
const { calculateVariantPricing } = require('../services/variant-pricing');
const { shouldAutoClose, autoCloseTimestamp, closeOrderAutomatically } = require('../services/auto-close');

function localDate(value) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day, 12);
}

test('conserva la semana actual y la semana anterior hasta el domingo', () => {
    assert.equal(getRetentionCutoff(localDate('2026-11-16')), '2026-11-09');
    assert.equal(getRetentionCutoff(localDate('2026-11-22')), '2026-11-09');
    assert.equal(getRetentionCutoff(localDate('2026-11-23')), '2026-11-16');
});

test('calcula el año y número ISO para el histórico semanal', () => {
    assert.deepEqual(getWeekArchiveMetadata('2025-12-29'), {
        semana_inicio: '2025-12-29',
        semana_fin: '2026-01-04',
        anio: 2026,
        numero_semana: 1
    });
});

test('cierra cuentas a partir de las 20:00 y recupera cuentas pendientes de días anteriores', () => {
    assert.equal(shouldAutoClose(localDate('2026-11-16'), new Date(2026, 10, 16, 19, 59)), false);
    assert.equal(shouldAutoClose(localDate('2026-11-16'), new Date(2026, 10, 16, 20, 0)), true);
    assert.equal(shouldAutoClose(new Date(2026, 10, 15, 19, 30), new Date(2026, 10, 16, 8, 0)), true);
    assert.equal(autoCloseTimestamp(new Date(2026, 10, 15, 19, 30), new Date(2026, 10, 16, 8, 0)).getHours(), 20);
});

test('el cierre automático no depende de impresión ni del cajón de efectivo', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'auto-close.js'), 'utf8');
    assert.doesNotMatch(source, /openCashDrawer|ticket-printer|printer-service/);
});

test('archiva únicamente el neto semanal antes de depurar', async () => {
    const inserts = [];
    let selectIndex = 0;
    const connection = {
        async query(sql, params) {
            if (/FROM facturas/.test(sql)) {
                selectIndex += 1;
                return [[{ semana_inicio: '2026-11-02', total_ventas: 100 }]];
            }
            if (/FROM gastos/.test(sql)) {
                selectIndex += 1;
                return [[{ semana_inicio: '2026-11-02', total_gastos: 20 }]];
            }
            if (/INSERT INTO resumenes_semanales/.test(sql)) {
                inserts.push(params);
                return [{ affectedRows: 1 }];
            }
            throw new Error(`SQL inesperado: ${sql}`);
        }
    };
    const result = await archiveExpiredWeeklySummaries(connection, '2026-11-09');
    assert.equal(selectIndex, 2);
    assert.deepEqual(result, { weeks: 1 });
    assert.deepEqual(inserts, [['2026-11-02', '2026-11-08', 2026, 45, 80]]);
});

test('confirma una cuenta automática sin ejecutar acciones posteriores al pago', async () => {
    const executed = [];
    const item = { id: 9, producto_id: 3, cantidad: 1, precio_unitario: 100, unidad_medida: 'UND', subtotal: 100 };
    const draft = JSON.stringify({
        total: 100,
        pagos: [{ metodo: 'efectivo', monto: 100 }],
        items_firma: [[9, 3, 1, 100]]
    });
    const connection = {
        async beginTransaction() { executed.push('begin'); },
        async commit() { executed.push('commit'); },
        async rollback() { executed.push('rollback'); },
        release() { executed.push('release'); },
        async query(sql) {
            executed.push(sql.replace(/\s+/g, ' ').trim());
            if (/SELECT p\.\*, m\.numero/.test(sql)) return [[{
                id: 5, mesa_id: 2, estado: 'abierto', pagos_borrador: draft,
                updated_at: new Date(2026, 10, 16, 19, 30)
            }]];
            if (/SELECT \* FROM pedido_items/.test(sql)) return [[item]];
            if (/SELECT id, estado FROM facturas/.test(sql)) return [[]];
            if (/INSERT INTO facturas/.test(sql)) return [{ insertId: 77 }];
            return [{ affectedRows: 1 }];
        }
    };
    const database = { async getConnection() { return connection; } };
    const result = await closeOrderAutomatically(5, new Date(2026, 10, 16, 20, 1), database);
    assert.equal(result.invoiceId, 77);
    assert.equal(result.automatic, true);
    assert.ok(executed.some(sql => /cierre_automatico = 1/.test(sql)));
    assert.ok(executed.includes('commit'));
    assert.ok(!executed.includes('rollback'));
});

test('suma automáticamente los costos extra de variantes', () => {
    const result = calculateVariantPricing(
        100,
        2,
        [{ id: 1, costo_extra: 20 }, { id: 2, costo_extra: 0 }],
        [{ key: 'i_1', cantidad: 1 }, { key: 'i_2', cantidad: 1 }]
    );
    assert.deepEqual(result, { costoExtraTotal: 20, precioUnitario: 110, subtotal: 220 });
});

test('rechaza asignaciones incompletas de variantes', () => {
    assert.throws(
        () => calculateVariantPricing(100, 2, [{ id: 1, costo_extra: 20 }], [{ key: 'i_1', cantidad: 1 }]),
        /Asigna exactamente 2 variantes/
    );
});
