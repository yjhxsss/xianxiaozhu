import { esc } from '../core/utils.js';

let container = null;
function init() {
  if (container) return;
  container = document.createElement('div');
  container.className = 'toast-container';
  document.body.appendChild(container);
}

export function toast(msg, type = 'info', options = {}) {
  init();
  const icons = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '❌' };
  const el = document.createElement('div');
  el.className = 'toast';

  const duration = options.duration || 2400;
  const actions = options.actions || [];

  let actionsHtml = '';
  if (actions.length) {
    actionsHtml = `<span style="margin-left:auto;display:flex;gap:6px">${
      actions.map((a, i) =>
        `<button class="btn btn-xs btn-primary" data-toast-action="${i}" type="button">${esc(a.label)}</button>`
      ).join('')
    }</span>`;
  }

  el.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span style="flex:1">${esc(msg)}</span>${actionsHtml}`;
  container.appendChild(el);

  let removed = false;
  function remove() {
    if (removed) return;
    removed = true;
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.transform = 'translateX(60px)';
    setTimeout(() => el.remove(), 300);
  }

  if (actions.length) {
    el.querySelectorAll('[data-toast-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.toastAction);
        try { actions[idx].onClick(); } catch (e) { console.error(e); }
        remove();
      });
    });
    // 带操作按钮的 toast 停久一点
    setTimeout(remove, options.actionDuration || 6000);
  } else {
    setTimeout(remove, duration);
  }

  return { remove };
}