let current = null;

export function show(id, html, size = 'md') {
  hide();
  const widths = { sm: 420, md: 560, lg: 740, xl: 960 };
  const maxW = widths[size] || widths.md;
  const overlay = document.createElement('div');
  overlay.id = 'modal-' + id;
  overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(10px);animation:fadeIn .25s ease;`;
  overlay.innerHTML = `<div style="background:var(--bg-card-solid);border-radius:20px;border:1px solid var(--border-l);padding:26px;width:92%;max-width:${maxW}px;max-height:88vh;overflow-y:auto;box-shadow:var(--shadow);animation:modalIn .35s cubic-bezier(.2,.8,.2,1)">${html}</div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) hide(); });
  document.body.appendChild(overlay);
  current = overlay;
  setTimeout(() => {
    const inp = overlay.querySelector('input, textarea, button');
    if (inp) inp.focus();
  }, 120);
}

export function hide() {
  if (current) { current.remove(); current = null; }
}