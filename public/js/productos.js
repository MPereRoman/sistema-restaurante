document.addEventListener('DOMContentLoaded', function() {
    const modal = new bootstrap.Modal(document.getElementById('nuevoProductoModal'));
    // Modal para gestión de hijos (Padre -> Hijos)
    // Relacionado con: views/productos.ejs (#hijosProductoModal) y routes/productos.js (/:padreId/hijos)
    const modalHijosEl = document.getElementById('hijosProductoModal');
    const modalHijos = modalHijosEl ? new bootstrap.Modal(modalHijosEl) : null;
    const formProducto = document.getElementById('formProducto');
    const buscarProducto = document.getElementById('buscarProducto');
    let timeoutId;

    // Estado UI para gestión de hijos
    let hijosPadreId = null;
    let hijosPadreNombre = '';
    let hijosActuales = []; // [{id,codigo,nombre}]
    let timeoutHijosSearch;

    // ===== Hijos como "items" de texto (nuevo) =====
    // Relacionado con: views/productos.ejs (#nuevoItemHijoNombre, #btnAgregarItemHijo, #listaItemsHijosConfigurados)
    // y routes/productos.js (/:padreId/hijos-items)
    let hijosItemsActuales = []; // [{id, producto_padre_id, nombre, orden}]

    function escapeHtml(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function setLoadingList(targetEl, show) {
        if (!targetEl) return;
        if (show) {
            targetEl.innerHTML = `
              <div class="list-group-item text-muted small">
                <span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
                Cargando...
              </div>`;
        } else {
            // noop (se reemplaza al renderizar)
        }
    }

    async function cargarHijosDelPadre() {
        const lista = document.getElementById('listaHijosConfigurados');
        const empty = document.getElementById('emptyHijosConfigurados');
        if (!lista || !empty) return;

        setLoadingList(lista, true);
        empty.classList.add('d-none');

        try {
            const resp = await fetch(`/api/productos/${encodeURIComponent(hijosPadreId)}/hijos`);
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || 'Error al cargar hijos');

            hijosActuales = Array.isArray(data) ? data : [];
            renderHijosActuales();
        } catch (err) {
            lista.innerHTML = `<div class="list-group-item text-danger small">${escapeHtml(err.message || 'Error al cargar hijos')}</div>`;
            hijosActuales = [];
        }
    }

    // ====== Items hijos (texto) ======
    async function cargarItemsHijosDelPadre() {
        const lista = document.getElementById('listaItemsHijosConfigurados');
        const empty = document.getElementById('emptyItemsHijosConfigurados');
        if (!lista || !empty) return;

        setLoadingList(lista, true);
        empty.classList.add('d-none');

        try {
            const resp = await fetch(`/api/productos/${encodeURIComponent(hijosPadreId)}/hijos-items`);
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || 'Error al cargar variantes');

            hijosItemsActuales = Array.isArray(data) ? data : [];
            renderItemsHijosActuales();
        } catch (err) {
            lista.innerHTML = `<div class="list-group-item text-danger small">${escapeHtml(err.message || 'Error al cargar variantes')}</div>`;
            hijosItemsActuales = [];
        }
    }

    function renderItemsHijosActuales() {
        const lista = document.getElementById('listaItemsHijosConfigurados');
        const empty = document.getElementById('emptyItemsHijosConfigurados');
        if (!lista || !empty) return;

        lista.innerHTML = '';
        if (!hijosItemsActuales || hijosItemsActuales.length === 0) {
            empty.classList.remove('d-none');
            return;
        }
        empty.classList.add('d-none');

        hijosItemsActuales.forEach(it => {
            const item = document.createElement('div');
            item.className = 'list-group-item d-flex justify-content-between align-items-center';
            item.innerHTML = `
              <div class="fw-semibold">${escapeHtml(it.nombre || '')}</div>
              <button type="button" class="btn btn-sm btn-outline-danger" data-item-hijo-id="${escapeHtml(it.id)}" title="Quitar variante">
                <i class="bi bi-x-lg"></i>
              </button>
            `;
            lista.appendChild(item);
        });
    }

    async function agregarItemHijo(nombre) {
        try {
            const resp = await fetch(`/api/productos/${encodeURIComponent(hijosPadreId)}/hijos-items`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nombre: String(nombre || '').trim() })
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || 'Error al agregar variante');
            await cargarItemsHijosDelPadre();
        } catch (err) {
            alert(err.message || 'No se pudo agregar la variante');
        }
    }

    async function quitarItemHijo(itemId) {
        try {
            const resp = await fetch(`/api/productos/${encodeURIComponent(hijosPadreId)}/hijos-items/${encodeURIComponent(itemId)}`, {
                method: 'DELETE',
                headers: { 'Accept': 'application/json' }
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || 'Error al quitar variante');
            await cargarItemsHijosDelPadre();
        } catch (err) {
            alert(err.message || 'No se pudo quitar la variante');
        }
    }

    // Delegación: quitar item hijo desde lista
    document.getElementById('listaItemsHijosConfigurados')?.addEventListener('click', function (e) {
        const btn = e.target.closest('button[data-item-hijo-id]');
        if (!btn) return;
        const itemId = btn.getAttribute('data-item-hijo-id');
        if (!itemId) return;
        if (confirm('¿Quitar esta variante del producto base?')) {
            quitarItemHijo(itemId);
        }
    });

    // Agregar item hijo desde input + botón
    document.getElementById('btnAgregarItemHijo')?.addEventListener('click', async function () {
        const input = document.getElementById('nuevoItemHijoNombre');
        if (!input) return;
        const raw = String(input.value || '').trim();
        if (!raw) return alert('Escribe el nombre de la variante.');

        // Permitir agregar varios separados por coma
        const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
        for (const nombre of parts) {
            await agregarItemHijo(nombre);
        }

        input.value = '';
        input.focus();
    });

    // Enter en el input también agrega
    document.getElementById('nuevoItemHijoNombre')?.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('btnAgregarItemHijo')?.click();
        }
    });

    function renderHijosActuales() {
        const lista = document.getElementById('listaHijosConfigurados');
        const empty = document.getElementById('emptyHijosConfigurados');
        if (!lista || !empty) return;

        lista.innerHTML = '';
        if (!hijosActuales || hijosActuales.length === 0) {
            empty.classList.remove('d-none');
            return;
        }
        empty.classList.add('d-none');

        hijosActuales.forEach(h => {
            const item = document.createElement('div');
            item.className = 'list-group-item d-flex justify-content-between align-items-center';
            item.innerHTML = `
              <div>
                <div class="fw-semibold">${escapeHtml(h.nombre)}</div>
                <div class="small text-muted">${escapeHtml(h.codigo || '')}</div>
              </div>
              <button type="button" class="btn btn-sm btn-outline-danger" data-hijo-id="${escapeHtml(h.id)}" title="Quitar hijo">
                <i class="bi bi-x-lg"></i>
              </button>
            `;
            lista.appendChild(item);
        });
    }

    async function agregarHijo(hijoId) {
        try {
            const resp = await fetch(`/api/productos/${encodeURIComponent(hijosPadreId)}/hijos`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ producto_hijo_id: Number(hijoId) })
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || 'Error al agregar hijo');
            await cargarHijosDelPadre();
        } catch (err) {
            alert(err.message || 'No se pudo agregar el hijo');
        }
    }

    async function quitarHijo(hijoId) {
        try {
            const resp = await fetch(`/api/productos/${encodeURIComponent(hijosPadreId)}/hijos/${encodeURIComponent(hijoId)}`, {
                method: 'DELETE',
                headers: { 'Accept': 'application/json' }
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || 'Error al quitar hijo');
            await cargarHijosDelPadre();
        } catch (err) {
            alert(err.message || 'No se pudo quitar el hijo');
        }
    }

    // Delegación de eventos: quitar hijo desde la lista
    document.getElementById('listaHijosConfigurados')?.addEventListener('click', function (e) {
        const btn = e.target.closest('button[data-hijo-id]');
        if (!btn) return;
        const hijoId = btn.getAttribute('data-hijo-id');
        if (!hijoId) return;
        if (confirm('¿Quitar este hijo del producto padre?')) {
            quitarHijo(hijoId);
        }
    });

    // LEGADO (deshabilitado en UI): hijos como productos
    // Nota: el modal ya no muestra el buscador; se deja el código por compatibilidad y para no romper instalaciones viejas.
    const inputBuscarHijo = document.getElementById('buscarHijoProducto');
    const resultadosBuscar = document.getElementById('resultadosBuscarHijo');
    // Cache de sugerencias (para poder mostrar opciones incluso sin escribir)
    // Relacionado con: UX solicitada por el usuario (poder agregar sin encontrar por letras)
    let sugerenciasCache = null; // [{id,codigo,nombre,...}]

    function normalizarListaProductos(data) {
        return Array.isArray(data) ? data : [];
    }

    function filtrarCandidatos(lista) {
        // Quitar: padre y los que ya están como hijos
        const existingIds = new Set((hijosActuales || []).map(h => Number(h.id)));
        return (lista || []).filter(p => {
            const id = Number(p.id);
            if (!Number.isFinite(id)) return false;
            if (Number(id) === Number(hijosPadreId)) return false;
            if (existingIds.has(Number(id))) return false;
            return true;
        });
    }

    function renderResultadosAgregar(lista, { emptyMessage } = {}) {
        if (!resultadosBuscar) return;

        const filtered = filtrarCandidatos(lista);
        resultadosBuscar.innerHTML = '';

        if (filtered.length === 0) {
            resultadosBuscar.innerHTML = `
              <div class="list-group-item text-muted small">
                ${emptyMessage || 'Sin resultados para agregar.'}
                <div class="mt-2">
                  <button type="button" class="btn btn-sm btn-outline-secondary" id="btnMostrarSugerenciasHijos">
                    <i class="bi bi-lightbulb me-1"></i>Ver sugerencias
                  </button>
                </div>
              </div>
            `;
            return;
        }

        filtered.forEach(p => {
            // UX: render con botón "Agregar" explícito (más claro que un badge)
            const row = document.createElement('div');
            row.className = 'list-group-item d-flex justify-content-between align-items-center gap-2';
            row.innerHTML = `
              <div class="flex-grow-1">
                <div class="fw-semibold">${escapeHtml(p.nombre)}</div>
                <div class="small text-muted">${escapeHtml(p.codigo || '')}</div>
              </div>
              <button type="button" class="btn btn-sm btn-primary" data-add-hijo-id="${escapeHtml(p.id)}">
                <i class="bi bi-plus-lg me-1"></i>Agregar
              </button>
            `;

            // Click en fila agrega (sin el botón)
            row.addEventListener('click', async (ev) => {
                const btn = ev.target.closest('button[data-add-hijo-id]');
                if (btn) return;
                await agregarHijo(p.id);
                resultadosBuscar.innerHTML = '';
                inputBuscarHijo.value = '';
                inputBuscarHijo.focus();
            });

            // Click en botón "Agregar"
            row.querySelector('button[data-add-hijo-id]')?.addEventListener('click', async (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                await agregarHijo(p.id);
                resultadosBuscar.innerHTML = '';
                inputBuscarHijo.value = '';
                inputBuscarHijo.focus();
            });

            resultadosBuscar.appendChild(row);
        });
    }

    async function cargarSugerenciasHijos() {
        // Usamos el buscador existente con q vacío: devuelve 10 productos (LIMIT 10)
        // Relacionado con: routes/productos.js -> GET /productos/buscar
        try {
            const resp = await fetch('/api/productos/buscar?q=');
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || 'Error al cargar sugerencias');
            sugerenciasCache = normalizarListaProductos(data);
        } catch (_) {
            sugerenciasCache = [];
        }
        return sugerenciasCache;
    }

    async function mostrarSugerenciasEnResultados() {
        // Si no hay cache, cargamos
        if (!Array.isArray(sugerenciasCache)) {
            await cargarSugerenciasHijos();
        }
        renderResultadosAgregar(sugerenciasCache, {
            emptyMessage: 'No hay sugerencias disponibles. Crea primero productos para poder agregarlos como hijos.'
        });
    }

    // Delegación: botón "Ver sugerencias" dentro del contenedor de resultados
    resultadosBuscar?.addEventListener('click', function (e) {
        const btn = e.target.closest('#btnMostrarSugerenciasHijos');
        if (!btn) return;
        e.preventDefault();
        mostrarSugerenciasEnResultados();
    });

    inputBuscarHijo?.addEventListener('input', function () {
        clearTimeout(timeoutHijosSearch);
        const q = (this.value || '').trim();
        if (!resultadosBuscar) return;

        if (q.length === 0) {
            // UX: sin escribir, mostramos sugerencias para poder agregar sin “adivinar”
            mostrarSugerenciasEnResultados();
            return;
        }
        if (q.length < 2) {
            resultadosBuscar.innerHTML = `
              <div class="list-group-item text-muted small">
                Escribe al menos <strong>2</strong> caracteres para buscar.
                <div class="mt-2">
                  <button type="button" class="btn btn-sm btn-outline-secondary" id="btnMostrarSugerenciasHijos">
                    <i class="bi bi-lightbulb me-1"></i>Ver sugerencias
                  </button>
                </div>
              </div>
            `;
            return;
        }

        timeoutHijosSearch = setTimeout(async () => {
            try {
                const resp = await fetch(`/api/productos/buscar?q=${encodeURIComponent(q)}`);
                const data = await resp.json();
                if (!resp.ok) throw new Error(data.error || 'Error al buscar');

                const list = normalizarListaProductos(data);
                renderResultadosAgregar(list, {
                    emptyMessage: `Sin resultados para “${escapeHtml(q)}”. Intenta con otro nombre o código, o mira sugerencias.`
                });
            } catch (err) {
                resultadosBuscar.innerHTML = `<div class="list-group-item text-danger small">${escapeHtml(err.message || 'Error de búsqueda')}</div>`;
            }
        }, 250);
    });

    // Función GLOBAL llamada desde views/productos.ejs (delegación en la tabla)
    // No la movemos a otro archivo para mantener relación directa con el panel actual.
    window.gestionarHijosProducto = async function (padreId, padreNombre) {
        if (!modalHijos) return alert('Gestión de variantes no disponible.');

        hijosPadreId = Number(padreId);
        hijosPadreNombre = String(padreNombre || '');

        const titleEl = document.getElementById('hijosPadreNombre');
        const idEl = document.getElementById('hijosPadreId');
        if (titleEl) titleEl.textContent = hijosPadreNombre;
        if (idEl) idEl.value = String(hijosPadreId);

        // Reset UI
        hijosActuales = [];
        hijosItemsActuales = [];
        if (resultadosBuscar) {
            // UX: al abrir, mostrar sugerencias automáticamente para que sea obvio cómo agregar
            resultadosBuscar.innerHTML = `
              <div class="list-group-item text-muted small">
                Cargando sugerencias...
              </div>
            `;
        }
        if (inputBuscarHijo) inputBuscarHijo.value = '';
        const inputItem = document.getElementById('nuevoItemHijoNombre');
        if (inputItem) inputItem.value = '';

        modalHijos.show();
        // Cargar primero el modo nuevo (items de texto)
        await cargarItemsHijosDelPadre();
        await cargarHijosDelPadre();
        await cargarSugerenciasHijos();
        await mostrarSugerenciasEnResultados();

        // Enfocar input de ítems al abrir (flujo principal)
        setTimeout(() => document.getElementById('nuevoItemHijoNombre')?.focus(), 250);
    };
    
    // Manejar búsqueda de productos con debounce
    buscarProducto.addEventListener('input', function(e) {
        const searchTerm = e.target.value.toLowerCase();
        
        // Limpiar el timeout anterior
        clearTimeout(timeoutId);
        
        // Si el término de búsqueda está vacío, mostrar todos los productos
        if (!searchTerm) {
            document.querySelectorAll('#productosTabla tr').forEach(row => {
                row.style.display = '';
            });
            return;
        }
        
        // Esperar 300ms antes de realizar la búsqueda
        timeoutId = setTimeout(() => {
            document.querySelectorAll('#productosTabla tr').forEach(row => {
                const codigo = row.cells[0].textContent.toLowerCase();
                const nombre = row.cells[1].textContent.toLowerCase();
                row.style.display = 
                    codigo.includes(searchTerm) || nombre.includes(searchTerm) 
                        ? '' 
                        : 'none';
            });
        }, 300);
    });

    // Teclas rápidas
    document.addEventListener('keydown', function(e) {
        // Evitar que las teclas rápidas se activen cuando se está escribiendo en un input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            return;
        }

        if (e.ctrlKey || e.metaKey) { // Ctrl en Windows/Linux o Cmd en Mac
            switch(e.key.toLowerCase()) {
                case 'b': // Ctrl/Cmd + B para buscar producto
                    e.preventDefault();
                    buscarProducto.focus();
                    break;
                case 'n': // Ctrl/Cmd + N para nuevo producto
                    e.preventDefault();
                    modal.show();
                    document.getElementById('codigo').focus();
                    break;
            }
        } else if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
            // Tecla '/' para buscar (sin modificadores)
            if (e.key === '/') {
                e.preventDefault();
                buscarProducto.focus();
            }
        }
    });

    // Manejar guardado de producto
    document.getElementById('guardarProducto').addEventListener('click', async function() {
        if (!formProducto.checkValidity()) {
            formProducto.reportValidity();
            return;
        }

        const productoData = {
            codigo: document.getElementById('codigo').value,
            nombre: document.getElementById('nombre').value,
            // KG se conserva oculto para una futura reactivación.
            precio_kg: parseFloat(document.getElementById('precioKg').value) || 0,
            precio_unidad: parseFloat(document.getElementById('precioUnidad').value) || 0,
            precio_libra: 0
        };

        const productoId = document.getElementById('productoId').value;
        const url = productoId ? `/productos/${productoId}` : '/productos';
        const method = productoId ? 'PUT' : 'POST';

        try {
            const response = await fetch(url, {
                method: method,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(productoData)
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Error al guardar el producto');
            }

            location.reload();
        } catch (error) {
            alert(error.message);
        }
    });

    // Limpiar formulario al abrir modal para nuevo producto
    document.getElementById('nuevoProductoModal').addEventListener('show.bs.modal', function(event) {
        if (!event.relatedTarget) return; // Si se abre para editar, no limpiar
        
        document.getElementById('productoId').value = '';
        document.getElementById('formProducto').reset();
        document.getElementById('modalTitle').textContent = 'Nuevo Producto';
        
        // Enfocar el campo de código después de que el modal se muestre completamente
        setTimeout(() => {
            document.getElementById('codigo').focus();
        }, 500);
    });

    // Agregar tooltips para mostrar las teclas rápidas
    const tooltips = [
        { 
            element: buscarProducto, 
            title: 'Teclas rápidas: Ctrl+B o /'
        },
        {
            element: document.querySelector('[data-bs-target="#nuevoProductoModal"]'),
            title: 'Tecla rápida: Ctrl+N'
        }
    ];

    tooltips.forEach(({element, title}) => {
        if (element) {
            element.setAttribute('title', title);
            new bootstrap.Tooltip(element);
        }
    });
});

// Función para editar producto
function editarProducto(id) {
    fetch(`/productos/${id}`)
        .then(response => response.json())
        .then(producto => {
            document.getElementById('productoId').value = producto.id;
            document.getElementById('codigo').value = producto.codigo;
            document.getElementById('nombre').value = producto.nombre;
            document.getElementById('precioKg').value = producto.precio_kg;
            document.getElementById('precioUnidad').value = producto.precio_unidad;
            document.getElementById('precioLibra').value = 0;
            
            document.getElementById('modalTitle').textContent = 'Editar Producto';
            const modal = new bootstrap.Modal(document.getElementById('nuevoProductoModal'));
            modal.show();
        })
        .catch(error => alert('Error al cargar el producto'));
}

// Función para eliminar producto
function eliminarProducto(id) {
    if (!confirm('¿Está seguro de eliminar este producto?')) {
        return;
    }

    fetch(`/productos/${id}`, {
        method: 'DELETE'
    })
        .then(response => {
            if (!response.ok) {
                throw new Error('Error al eliminar el producto');
            }
            location.reload();
        })
        .catch(error => alert(error.message));
} 
