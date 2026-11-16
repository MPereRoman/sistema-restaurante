function calculateVariantPricing(precioBaseValue, cantidadValue, variantesDisponibles, seleccionValue) {
    const precioBase = Number(precioBaseValue || 0);
    const cantidad = Number(cantidadValue);
    if (!Number.isFinite(precioBase) || precioBase < 0) throw new Error('Precio base inválido');
    if (!Number.isInteger(cantidad) || cantidad <= 0) throw new Error('Cantidad inválida');

    const disponibles = Array.isArray(variantesDisponibles) ? variantesDisponibles : [];
    const seleccion = Array.isArray(seleccionValue) ? seleccionValue : [];
    let costoExtraTotal = 0;

    if (disponibles.length > 0) {
        const costos = new Map(disponibles.map(row => [String(row.id), Number(row.costo_extra || 0)]));
        const normalizadas = seleccion.map(item => {
            const match = String(item?.key || '').match(/^i_(\d+)$/);
            const cantidadVariante = Number(item?.cantidad || 0);
            if (!match || !Number.isInteger(cantidadVariante) || cantidadVariante <= 0 || !costos.has(match[1])) {
                throw new Error('La selección de variantes no es válida');
            }
            return { id: match[1], cantidad: cantidadVariante };
        });
        const totalVariantes = normalizadas.reduce((sum, item) => sum + item.cantidad, 0);
        if (totalVariantes !== cantidad) {
            throw new Error(`Asigna exactamente ${cantidad} variante${cantidad === 1 ? '' : 's'}`);
        }
        costoExtraTotal = normalizadas.reduce((sum, item) => sum + (costos.get(item.id) * item.cantidad), 0);
    }

    const subtotal = Math.round(((precioBase * cantidad) + costoExtraTotal) * 100) / 100;
    const precioUnitario = Math.round((subtotal / cantidad) * 100) / 100;
    return { costoExtraTotal, precioUnitario, subtotal };
}

module.exports = { calculateVariantPricing };
