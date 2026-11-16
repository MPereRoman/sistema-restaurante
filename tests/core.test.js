const test = require('node:test');
const assert = require('node:assert/strict');
const { getRetentionCutoff } = require('../services/retention');
const { calculateVariantPricing } = require('../services/variant-pricing');

function localDate(value) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day, 12);
}

test('conserva la semana actual y la semana anterior hasta el domingo', () => {
    assert.equal(getRetentionCutoff(localDate('2026-11-16')), '2026-11-09');
    assert.equal(getRetentionCutoff(localDate('2026-11-22')), '2026-11-09');
    assert.equal(getRetentionCutoff(localDate('2026-11-23')), '2026-11-16');
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
