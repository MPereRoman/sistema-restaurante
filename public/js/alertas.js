(function () {
  const ENABLED_KEY = 'pos:alertas:enabled';
  const DEDUPE_MS = 10000;
  let audioContext = null;

  function isEnabled() {
    return localStorage.getItem(ENABLED_KEY) === '1';
  }

  function updateButtons() {
    document.querySelectorAll('[data-pos-alert-toggle]').forEach((button) => {
      const enabled = isEnabled();
      button.classList.toggle('btn-outline-secondary', !enabled);
      button.classList.toggle('btn-success', enabled);
      button.innerHTML = enabled
        ? '<i class="bi bi-bell-fill me-1"></i>Alertas activas'
        : '<i class="bi bi-bell me-1"></i>Activar alertas';
    });
  }

  function toastContainer() {
    let container = document.getElementById('posAlertContainer');
    if (container) return container;
    container = document.createElement('div');
    container.id = 'posAlertContainer';
    container.style.cssText = 'position:fixed;top:72px;right:12px;z-index:2000;width:min(380px,calc(100vw - 24px));display:grid;gap:8px;';
    document.body.appendChild(container);
    return container;
  }

  function showToast(title, body, url) {
    const toast = document.createElement('div');
    toast.className = 'alert alert-warning shadow border-start border-4 border-warning mb-0';
    toast.style.cursor = url ? 'pointer' : 'default';
    toast.innerHTML = `<div class="fw-bold"><i class="bi bi-bell-fill me-1"></i>${escapeHtml(title)}</div><div class="small mt-1">${escapeHtml(body)}</div>`;
    if (url) toast.addEventListener('click', () => { window.location.href = url; });
    toastContainer().appendChild(toast);
    window.setTimeout(() => toast.remove(), 9000);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function ensureAudio() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    if (!audioContext) audioContext = new AudioCtor();
    if (audioContext.state === 'suspended') {
      try { await audioContext.resume(); } catch (_) {}
    }
    return audioContext;
  }

  async function beep() {
    try {
      const ctx = await ensureAudio();
      if (!ctx || ctx.state !== 'running') return;
      const inicio = ctx.currentTime;
      const notas = [
        { frecuencia: 740, inicio: 0.00, duracion: 0.30 },
        { frecuencia: 1046, inicio: 0.38, duracion: 0.30 },
        { frecuencia: 740, inicio: 0.76, duracion: 0.30 },
        { frecuencia: 1175, inicio: 1.14, duracion: 0.48 }
      ];
      notas.forEach(function (nota) {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        const t0 = inicio + nota.inicio;
        oscillator.type = 'square';
        oscillator.frequency.setValueAtTime(nota.frecuencia, t0);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.30, t0 + 0.025);
        gain.gain.setValueAtTime(0.30, t0 + Math.max(0.03, nota.duracion - 0.08));
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + nota.duracion);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start(t0);
        oscillator.stop(t0 + nota.duracion + 0.02);
      });
    } catch (_) {}
  }

  async function enable() {
    localStorage.setItem(ENABLED_KEY, '1');
    await ensureAudio();
    if (window.isSecureContext && 'Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch (_) {}
    }
    updateButtons();
    showToast('Alertas activadas', 'Los avisos sonarán mientras el POS esté abierto en este dispositivo.');
    await beep();
  }

  function disable() {
    localStorage.setItem(ENABLED_KEY, '0');
    updateButtons();
  }

  async function notify(options) {
    if (!isEnabled()) return false;
    const title = String(options?.title || 'Nuevo aviso');
    const body = String(options?.body || '');
    const tag = String(options?.tag || `${title}:${body}`);
    const url = String(options?.url || '');
    const dedupeKey = `pos:alerta:${tag}`;
    const last = Number(localStorage.getItem(dedupeKey) || 0);
    if (Date.now() - last < DEDUPE_MS) return false;
    localStorage.setItem(dedupeKey, String(Date.now()));

    showToast(title, body, url);
    beep();

    if (window.isSecureContext && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const notification = new Notification(title, { body, tag, renotify: true });
        notification.onclick = function () {
          window.focus();
          if (url) window.location.href = url;
          notification.close();
        };
      } catch (_) {}
    }
    return true;
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-pos-alert-toggle]');
    if (!button) return;
    if (isEnabled()) disable(); else enable();
  });
  document.addEventListener('DOMContentLoaded', updateButtons);

  window.PosAlerts = { disable, enable, isEnabled, notify, updateButtons };
})();
