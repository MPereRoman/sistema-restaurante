document.addEventListener('DOMContentLoaded', () => {
    const $ = id => document.getElementById(id);
    const money = value => `$${Number(value || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[ch]));
    let resumen = null;

    function showAlert(message, type = 'success') {
        const alert = $('alertaCaja');
        alert.className = `alert alert-${type}`;
        alert.textContent = message;
        alert.classList.remove('d-none');
        setTimeout(() => alert.classList.add('d-none'), 4500);
    }

    function setSignedValue(element, value) {
        element.textContent = money(value);
        element.classList.toggle('text-danger', Number(value) < 0);
        element.classList.toggle('text-success', Number(value) >= 0);
    }

    function render(data) {
        resumen = data;
        $('mVentas').textContent = money(data.total_ventas);
        $('mGastos').textContent = money(data.total_gastos);
        setSignedValue($('mResultado'), data.resultado_operativo);
        setSignedValue($('mCaja'), data.saldo_caja_estimado);
        $('fondoMonto').value = Number(data.fondo_caja || 0).toFixed(2);

        const gastos = Array.isArray(data.gastos) ? data.gastos : [];
        $('gastosCount').textContent = gastos.length;
        $('sinGastos').classList.toggle('d-none', gastos.length > 0);
        $('gastosTabla').innerHTML = gastos.map(gasto => `
            <tr>
                <td><div class="fw-semibold">${escapeHtml(gasto.concepto)}</div><div class="small text-muted">${new Date(gasto.created_at).toLocaleTimeString('es-MX', {hour:'2-digit', minute:'2-digit'})}</div></td>
                <td class="text-capitalize">${escapeHtml(gasto.metodo_pago)}</td>
                <td class="text-end fw-semibold">${money(gasto.total)}</td>
                <td class="text-end"><button class="btn btn-sm btn-outline-danger" data-delete-gasto="${gasto.id}" title="Eliminar gasto"><i class="bi bi-trash"></i></button></td>
            </tr>`).join('');

        const cortes = Array.isArray(data.cortes) ? data.cortes : [];
        $('sinCortes').classList.toggle('d-none', cortes.length > 0);
        $('cortesLista').innerHTML = cortes.map(corte => `
            <div class="list-group-item d-flex justify-content-between align-items-center gap-3">
                <div><div class="fw-semibold">Corte #${corte.id}</div><div class="small text-muted">${new Date(corte.created_at).toLocaleString('es-MX')} · ${escapeHtml(corte.creado_por_nombre || 'Administrador')}</div></div>
                <div class="text-end"><div class="fw-semibold ${Number(corte.resultado_operativo) < 0 ? 'text-danger' : 'text-success'}">${money(corte.resultado_operativo)}</div><div class="small text-muted">${corte.numero_facturas} facturas</div></div>
            </div>`).join('');
    }

    async function loadSummary() {
        const fecha = $('fechaCaja').value;
        const response = await fetch(`/api/gastos/resumen?fecha=${encodeURIComponent(fecha)}`, { headers: { Accept:'application/json' } });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'No se pudo cargar el resumen');
        render(data);
    }

    $('fechaCaja').addEventListener('change', () => loadSummary().catch(error => showAlert(error.message, 'danger')));

    $('guardarFondo').addEventListener('click', async () => {
        try {
            const response = await fetch('/api/gastos/fondo', {
                method:'PUT', headers:{'Content-Type':'application/json', Accept:'application/json'},
                body:JSON.stringify({ fecha:$('fechaCaja').value, monto:Number($('fondoMonto').value) })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'No se pudo guardar el fondo');
            showAlert(data.message);
            await loadSummary();
        } catch (error) { showAlert(error.message, 'danger'); }
    });

    $('formGasto').addEventListener('submit', async event => {
        event.preventDefault();
        try {
            const response = await fetch('/api/gastos', {
                method:'POST', headers:{'Content-Type':'application/json', Accept:'application/json'},
                body:JSON.stringify({
                    fecha:$('fechaCaja').value,
                    concepto:$('gastoConcepto').value,
                    total:Number($('gastoTotal').value),
                    metodo_pago:$('gastoMetodo').value
                })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'No se pudo registrar el gasto');
            event.target.reset();
            $('gastoMetodo').value = 'efectivo';
            showAlert(data.message);
            await loadSummary();
        } catch (error) { showAlert(error.message, 'danger'); }
    });

    $('gastosTabla').addEventListener('click', async event => {
        const button = event.target.closest('[data-delete-gasto]');
        if (!button || !confirm('¿Eliminar este gasto? El resumen y los próximos cortes se recalcularán.')) return;
        try {
            const response = await fetch(`/api/gastos/${encodeURIComponent(button.dataset.deleteGasto)}`, { method:'DELETE', headers:{Accept:'application/json'} });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'No se pudo eliminar el gasto');
            showAlert(data.message);
            await loadSummary();
        } catch (error) { showAlert(error.message, 'danger'); }
    });

    loadSummary().catch(error => showAlert(error.message, 'danger'));
});
