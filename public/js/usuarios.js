// Panel de Usuarios (solo administrador)
// Relacionado con:
// - views/usuarios.ejs (tabla y modales)
// - routes/usuarios.js (API /api/usuarios/*)

document.addEventListener('DOMContentLoaded', function () {
  const usuarioModalEl = document.getElementById('usuarioModal');
  const usuarioModal = usuarioModalEl ? new bootstrap.Modal(usuarioModalEl) : null;
  const passwordModalEl = document.getElementById('passwordModal');
  const passwordModal = passwordModalEl ? new bootstrap.Modal(passwordModalEl) : null;

  function qs(id) { return document.getElementById(id); }
  function showError(id, msg) {
    const el = qs(id);
    if (!el) return;
    el.textContent = String(msg || '');
    el.classList.toggle('d-none', !msg);
  }

  async function fetchJson(url, options) {
    const resp = await fetch(url, options);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || 'Error');
    return data;
  }

  async function recargarTabla() {
    const tbody = qs('tbodyUsuarios');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="6" class="text-muted small">Cargando...</td></tr>`;
    try {
      const list = await fetchJson('/api/usuarios/listar');
      tbody.innerHTML = '';
      list.forEach(u => {
        const tr = document.createElement('tr');
        tr.setAttribute('data-id', u.id);
        tr.innerHTML = `
          <td class="mono">${escapeHtml(u.usuario)}</td>
          <td>${escapeHtml(u.nombre || '')}</td>
          <td><span class="badge text-bg-secondary">${escapeHtml(u.rol)}</span></td>
          <td>${Number(u.activo) === 1 ? '<span class="badge text-bg-success">Activo</span>' : '<span class="badge text-bg-secondary">Inactivo</span>'}</td>
          <td class="small text-muted">${u.last_login ? new Date(u.last_login).toLocaleString() : '-'}</td>
          <td class="text-end">
            <div class="btn-group">
              <button class="btn btn-sm btn-outline-primary" data-action="editar"><i class="bi bi-pencil"></i></button>
              <button class="btn btn-sm btn-outline-warning" data-action="password" title="Cambiar contraseña"><i class="bi bi-key"></i></button>
              <button class="btn btn-sm btn-outline-danger" data-action="eliminar"><i class="bi bi-trash"></i></button>
            </div>
          </td>
        `;
        tbody.appendChild(tr);
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-danger small">${escapeHtml(e.message || 'Error')}</td></tr>`;
    }
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function abrirNuevo() {
    qs('usuarioModalTitle').textContent = 'Nuevo usuario';
    qs('usuarioId').value = '';
    qs('usuarioUsuario').value = '';
    qs('usuarioNombre').value = '';
    qs('usuarioRol').value = 'mesero';
    qs('usuarioActivo').checked = true;
    qs('usuarioPassword').value = '';
    qs('wrapPassword')?.classList.remove('d-none');
    showError('usuarioError', '');
    usuarioModal?.show();
    setTimeout(() => qs('usuarioUsuario')?.focus(), 250);
  }

  function abrirEditarDesdeFila(tr) {
    const id = tr.getAttribute('data-id');
    const tds = tr.querySelectorAll('td');
    const usuario = tds[0]?.textContent?.trim() || '';
    const nombre = tds[1]?.textContent?.trim() || '';
    const rol = tr.querySelector('td:nth-child(3) .badge')?.textContent?.trim() || 'mesero';
    const activo = (tr.querySelector('td:nth-child(4) .badge')?.textContent || '').toLowerCase().includes('activo');

    qs('usuarioModalTitle').textContent = 'Editar usuario';
    qs('usuarioId').value = id;
    qs('usuarioUsuario').value = usuario;
    qs('usuarioNombre').value = nombre;
    qs('usuarioRol').value = rol;
    qs('usuarioActivo').checked = !!activo;
    qs('usuarioPassword').value = '';
    qs('wrapPassword')?.classList.add('d-none');
    showError('usuarioError', '');
    usuarioModal?.show();
    setTimeout(() => qs('usuarioUsuario')?.focus(), 250);
  }

  async function guardarUsuario() {
    showError('usuarioError', '');
    const id = qs('usuarioId').value;
    const body = {
      usuario: qs('usuarioUsuario').value.trim(),
      nombre: qs('usuarioNombre').value.trim(),
      rol: qs('usuarioRol').value,
      activo: qs('usuarioActivo').checked ? 1 : 0
    };
    const password = qs('usuarioPassword').value;

    try {
      if (!body.usuario) throw new Error('Usuario requerido');
      if (!body.rol) throw new Error('Rol requerido');

      if (!id) {
        if (!password) throw new Error('Contraseña requerida');
        await fetchJson('/api/usuarios', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, password })
        });
      } else {
        await fetchJson(`/api/usuarios/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      }
      usuarioModal?.hide();
      await recargarTabla();
      Swal.fire({ icon: 'success', title: 'Guardado' });
    } catch (e) {
      showError('usuarioError', e.message || 'Error');
    }
  }

  function abrirPassword(tr) {
    const id = tr.getAttribute('data-id');
    qs('passwordUserId').value = id;
    qs('passwordNueva').value = '';
    qs('passwordNueva2').value = '';
    showError('passwordError', '');
    passwordModal?.show();
    setTimeout(() => qs('passwordNueva')?.focus(), 250);
  }

  async function guardarPassword() {
    showError('passwordError', '');
    const id = qs('passwordUserId').value;
    const p1 = qs('passwordNueva').value;
    const p2 = qs('passwordNueva2').value;
    try {
      if (!p1) throw new Error('Contraseña requerida');
      if (p1 !== p2) throw new Error('Las contraseñas no coinciden');
      await fetchJson(`/api/usuarios/${encodeURIComponent(id)}/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: p1 })
      });
      passwordModal?.hide();
      Swal.fire({ icon: 'success', title: 'Contraseña actualizada' });
    } catch (e) {
      showError('passwordError', e.message || 'Error');
    }
  }

  async function eliminarUsuario(tr) {
    const id = tr.getAttribute('data-id');
    const usuario = tr.querySelector('td')?.textContent?.trim() || '';
    const ok = await Swal.fire({
      title: '¿Eliminar usuario?',
      text: `Se eliminará: ${usuario}`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Sí, eliminar',
      cancelButtonText: 'Cancelar'
    });
    if (!ok.isConfirmed) return;
    try {
      await fetchJson(`/api/usuarios/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await recargarTabla();
      Swal.fire({ icon: 'success', title: 'Eliminado' });
    } catch (e) {
      Swal.fire({ icon: 'error', title: e.message || 'Error' });
    }
  }

  // Eventos
  document.getElementById('btnNuevoUsuario')?.addEventListener('click', abrirNuevo);
  document.getElementById('btnGuardarUsuario')?.addEventListener('click', guardarUsuario);
  document.getElementById('btnGuardarPassword')?.addEventListener('click', guardarPassword);

  document.getElementById('tbodyUsuarios')?.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const action = btn.getAttribute('data-action');
    if (action === 'editar') abrirEditarDesdeFila(tr);
    if (action === 'password') abrirPassword(tr);
    if (action === 'eliminar') eliminarUsuario(tr);
  });

  // Carga inicial (asegura sincronía si se hicieron cambios por otra sesión)
  recargarTabla();
});

