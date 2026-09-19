import { DB, State, save, getDataVersion } from '../../core/db.js';
import { esc, today, uid } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { show as showModal, hide as hideModal } from '../../ui/modal.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';
import { evaluateFormula, validateFormula, extractVars } from '../../core/formula.js';

function values(mid) {
  const ver = getDataVersion();
  const cached = State.metricCache[mid];
  if (cached && cached._v === ver) return cached._data;
  const arr = DB.metricValues.filter(x => x.metric_id === mid);
  arr.sort((a, b) => new Date(a.savedAt || a.date) - new Date(b.savedAt || b.date));
  State.metricCache[mid] = { _v: ver, _data: arr };
  return arr;
}

function latest(mid) {
  const v = values(mid);
  return v.length ? v[v.length - 1].value : null;
}

function resolveVarMap(uid) {
  const map = {};
  const bases = DB.metrics.filter(x => x.user_id === uid && !x.isDerived);
  for (const b of bases) {
    const vals = DB.metricValues
      .filter(v => v.metric_id === b.id)
      .sort((a, b) => new Date(a.savedAt || a.date) - new Date(b.savedAt || b.date));
    if (vals.length) map[b.name] = vals[vals.length - 1].value;
  }
  return map;
}

function computeDerived(m, uid) {
  if (!m.isDerived || !m.formula) return null;
  return evaluateFormula(m.formula, resolveVarMap(uid));
}

function getMetricValue(m) {
  const uid = State.user?.id;
  if (!uid) return null;
  if (m.isDerived) return computeDerived(m, uid);
  return latest(m.id);
}

function sortMetrics(list) {
  return [...list].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  });
}

function hasTarget(m) {
  return !!(m && m.target_value != null && m.target_value > 0);
}

function progressPct(m, val) {
  if (!hasTarget(m) || val == null) return null;
  if (m.target_dir === 'lower') {
    if (val <= m.target_value) return 100;
    return Math.max(0, Math.min(100, Math.round(m.target_value / val * 100)));
  }
  return Math.max(0, Math.min(100, Math.round(val / m.target_value * 100)));
}

function devColor(m, val) {
  if (!hasTarget(m) || val == null) return 'var(--accent)';
  const dev = m.target_dir === 'lower' ? (val - m.target_value) / m.target_value : (m.target_value - val) / m.target_value;
  if (dev <= 0) return 'var(--success)';
  if (dev >= 0.2) return 'var(--danger)';
  return 'var(--warning)';
}

function round2(v) {
  const n = parseFloat(v);
  if (!isFinite(n)) return '--';
  if (Number.isInteger(n)) return String(n);
  return parseFloat(n.toFixed(2)).toString();
}

function cssVarToHex(varStr, fallback = '#7c6cf8') {
  if (!varStr) return fallback;
  if (!varStr.startsWith('var(')) return varStr;
  const m = varStr.match(/var\(\s*(--[\w-]+)\s*\)/);
  if (!m) return fallback;
  const name = m[1];
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function hexToRgba(hex, alpha) {
  if (!hex || !hex.startsWith('#')) return hex;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ============ 渲染 ============ */
export function renderPanel() {
  const raw = DB.metrics.filter(m => m.user_id === State.user.id);
  const list = sortMetrics(raw);
  const mode = State.viewMode.metrics || 'card';

  let body;
  if (!list.length) body = '<div class="metric-empty">暂无指标，去设置添加，或点右上角「+ 数据」</div>';
  else if (mode === 'compact') body = renderCompact(list);
  else if (mode === 'ring') body = renderRing(list);
  else if (mode === 'bar') body = renderBar(list);
  else body = renderCard(list);

  return `
    <div class="panel" id="metricsPanel">
      <div class="panel-title">
        <span class="title-icon">📊</span>指标大图
        <button class="btn btn-xs btn-primary" data-action="metric-quick-add" type="button" title="快速添加数据">+ 数据</button>
        <div class="view-toggle" style="margin-left:auto">
          <button class="${mode === 'card' ? 'active' : ''}" data-action="view-mode" data-mode="card" type="button">📇 卡片</button>
          <button class="${mode === 'compact' ? 'active' : ''}" data-action="view-mode" data-mode="compact" type="button">📋 列表</button>
          <button class="${mode === 'ring' ? 'active' : ''}" data-action="view-mode" data-mode="ring" type="button">◯ 圆环</button>
          <button class="${mode === 'bar' ? 'active' : ''}" data-action="view-mode" data-mode="bar" type="button">▬ 进度条</button>
        </div>
      </div>
      <div id="metricsPanelBody">${body}</div>
    </div>`;
}

function renderCard(list) {
  return `<div class="metrics-big-grid">${list.map((m, i) => {
    const val = getMetricValue(m);
    const pct = progressPct(m, val);
    const color = devColor(m, val);
    const vals = m.isDerived ? [] : values(m.id);
    const pin = m.pinned ? ' pinned' : '';
    const isDone = pct !== null && pct >= 100;
    const valueStr = val !== null && val !== undefined ? round2(val) : '--';
    return `<div class="metric-big-card${pin}${isDone ? ' completed' : ''}" data-action="metric-detail" data-id="${m.id}" style="--i:${i}">
      <div class="metric-card-tools">
        <button class="metric-pin-btn${m.pinned ? ' active' : ''}" data-action="metric-toggle-pin" data-id="${m.id}" type="button">📌</button>
        <button class="metric-edit-btn" data-action="metric-edit" data-id="${m.id}" type="button">✎</button>
      </div>
      <div class="metric-big-head">
        <span class="metric-big-dot" style="background:${color};color:${color}"></span>
        <span class="metric-big-name">${esc(m.name)}${m.isDerived ? ' <span class="metric-formula-tag">ƒ</span>' : ''}</span>
      </div>
      <div class="metric-big-value metric-value-anim"
           data-metric-value-id="${m.id}"
           data-value="${val ?? ''}">${valueStr}<span class="unit">${esc(m.unit)}</span></div>
      <div class="metric-big-target">
        <span>${hasTarget(m) ? '目标 ' + m.target_value : '无目标'}</span>
        <span>${m.isDerived ? '公式' : vals.length + ' 条'}</span>
      </div>
      ${pct !== null ? `<div class="metric-big-bar"><div class="metric-big-bar-fill" style="background:${color};width:${pct}%"></div></div>` : ''}
      ${!m.isDerived && vals.length >= 2 ? `<canvas class="metric-big-spark" id="spark_${m.id}"></canvas>` : ''}
    </div>`;
  }).join('')}</div>`;
}

function renderCompact(list) {
  return `<div class="metrics-compact">${list.map((m, i) => {
    const val = getMetricValue(m);
    const color = devColor(m, val);
    return `<div class="metric-row${m.pinned ? ' pinned' : ''}" data-action="metric-detail" data-id="${m.id}" style="--i:${i}">
      <button class="metric-pin-btn small" data-action="metric-toggle-pin" data-id="${m.id}" type="button">${m.pinned ? '📌' : '·'}</button>
      <span class="metric-row-dot" style="background:${color}"></span>
      <span class="metric-row-name">${esc(m.name)}${m.isDerived ? ' <span class="metric-formula-tag">ƒ</span>' : ''}</span>
      <span class="metric-row-value metric-value-anim"
            data-metric-value-id="${m.id}"
            data-value="${val ?? ''}">${val !== null && val !== undefined ? round2(val) : '--'}<span class="metric-row-unit">${esc(m.unit)}</span></span>
      <button class="metric-edit-btn small" data-action="metric-edit" data-id="${m.id}" type="button">✎</button>
    </div>`;
  }).join('')}</div>`;
}

function renderRing(list) {
  return `<div class="metrics-ring-grid">${list.map((m, i) => {
    const val = getMetricValue(m);
    const pct = progressPct(m, val);
    const color = devColor(m, val);
    const size = 132, stroke = 11, radius = (size - stroke) / 2 - 3;
    const circ = 2 * Math.PI * radius;
    const ratio = pct === null ? 0 : pct / 100;
    const offset = circ * (1 - ratio);
    const isDone = pct !== null && pct >= 100;
    return `<div class="metric-ring-card${m.pinned ? ' pinned' : ''}${isDone ? ' completed' : ''}" data-action="metric-detail" data-id="${m.id}" style="--i:${i}">
      <div class="metric-card-tools">
        <button class="metric-pin-btn${m.pinned ? ' active' : ''}" data-action="metric-toggle-pin" data-id="${m.id}" type="button">📌</button>
        <button class="metric-edit-btn" data-action="metric-edit" data-id="${m.id}" type="button">✎</button>
      </div>
      <div class="metric-ring-svg-wrap">
        <svg viewBox="0 0 ${size} ${size}">
          <circle class="ring-track" cx="${size/2}" cy="${size/2}" r="${radius}" fill="none" stroke-width="${stroke}"/>
          ${pct !== null ? `<circle class="ring-progress" cx="${size/2}" cy="${size/2}" r="${radius}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${circ.toFixed(2)}" data-offset="${offset.toFixed(2)}" style="color:${color}"/>` : ''}
        </svg>
        <div class="metric-ring-center">
          <div class="metric-ring-value metric-value-anim"
               data-metric-value-id="${m.id}"
               data-value="${val ?? ''}">${val !== null && val !== undefined ? round2(val) : '--'}</div>
          <div class="metric-ring-unit">${esc(m.unit) || '&nbsp;'}</div>
        </div>
      </div>
      <div class="metric-ring-name">${esc(m.name)}${m.isDerived ? ' <span class="metric-formula-tag">ƒ</span>' : ''}</div>
      <div class="metric-ring-foot">
        ${pct !== null ? `<span class="metric-ring-pct" style="color:${color}">${pct}%</span>` : ''}
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderBar(list) {
  return `<div class="metrics-bar-list">${list.map((m, i) => {
    const val = getMetricValue(m);
    const pct = progressPct(m, val);
    const color = devColor(m, val);
    const isDone = pct !== null && pct >= 100;
    const valStr = val !== null && val !== undefined ? round2(val) : '--';
    const trackColor = hexToRgba(cssVarToHex(color), 0.15);

    return `<div class="metric-bar-item${m.pinned ? ' pinned' : ''}${isDone ? ' completed' : ''}" data-action="metric-detail" data-id="${m.id}" style="--i:${i}">
      <div class="metric-bar-head">
        <button class="metric-pin-btn small" data-action="metric-toggle-pin" data-id="${m.id}" type="button" title="${m.pinned ? '取消置顶' : '置顶'}">${m.pinned ? '📌' : '·'}</button>
        <span class="metric-bar-name">${esc(m.name)}${m.isDerived ? ' <span class="metric-formula-tag">ƒ</span>' : ''}</span>
        <span class="metric-bar-value metric-value-anim"
              style="color:${color}"
              data-metric-value-id="${m.id}"
              data-value="${val ?? ''}">${valStr}<span class="metric-bar-unit">${esc(m.unit)}</span></span>
        <button class="metric-bar-edit-btn" data-action="metric-edit" data-id="${m.id}" type="button" title="编辑">✎</button>
      </div>
      <div class="metric-bar-track" style="background:${trackColor}">
        <div class="metric-bar-fill" style="width:${pct || 0}%;background:${color}"></div>
      </div>
      <div class="metric-bar-footer">
        <span>${hasTarget(m) ? `目标 ${m.target_value} ${m.target_dir === 'lower' ? '↓' : '↑'}` : '无目标'}</span>
        <span>${m.isDerived ? '公式' : (values(m.id).length + ' 条')}</span>
      </div>
    </div>`;
  }).join('')}</div>`;
}

const _lastValues = new Map();

export function afterRender() {
  DB.metrics.forEach(m => {
    const el = document.querySelector(`[data-metric-value-id="${m.id}"]`);
    if (!el) return;
    const raw = el.dataset.value;
    const val = raw === '' ? null : parseFloat(raw);
    const prev = _lastValues.get(m.id);

    if (prev !== undefined && prev !== val && val !== null) {
      el.classList.remove('value-pop');
      void el.offsetWidth;
      el.classList.add('value-pop');
      setTimeout(() => el.classList.remove('value-pop'), 700);
    }
    _lastValues.set(m.id, val);
  });

  drawSparklines();
  animateRings();
}

function animateRings() {
  const nodes = document.querySelectorAll('.metric-ring-svg-wrap .ring-progress');
  if (!nodes.length) return;
  requestAnimationFrame(() => {
    nodes.forEach(n => {
      const t = n.getAttribute('data-offset');
      if (t != null) n.setAttribute('stroke-dashoffset', t);
    });
  });
}

function drawSparklines() {
  const list = DB.metrics.filter(m => m.user_id === State.user.id && !m.isDerived);
  list.forEach(m => {
    const canvas = document.getElementById('spark_' + m.id);
    if (!canvas) return;
    const vals = values(m.id);
    if (vals.length < 2) return;
    const data = vals.slice(-14);
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 10) return;
    canvas.width = rect.width * dpr;
    canvas.height = 28 * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = '28px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    const w = rect.width, h = 28;
    const nums = data.map(v => v.value);
    const min = Math.min(...nums), max = Math.max(...nums);
    const range = max - min || 1;
    const lineColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#7c6cf8';
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = 3 + i * (w - 6) / (data.length - 1);
      const y = 3 + (h - 6) * (1 - (v.value - min) / range);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
}

/* ============ 详情 ============ */
function renderDetail(m) {
  const val = getMetricValue(m);
  const isDerived = !!m.isDerived;
  const vals = isDerived ? [] : values(m.id);

  let bodyHtml = '';
  if (isDerived) {
    const varMap = resolveVarMap(State.user.id);
    const refs = extractVars(m.formula);
    bodyHtml = `
      <div class="metric-formula-block">
        <div class="mfb-label">ƒ 公式</div>
        <div class="mfb-formula">${esc(m.formula)}</div>
        <div class="mfb-vars">
          <div class="mfb-vars-label">依赖变量：</div>
          ${refs.length ? refs.map(v => `
            <div class="mfb-var-row">
              <span class="mfb-var-name">${esc(v)}</span>
              <span class="mfb-var-value">${varMap[v] != null ? round2(varMap[v]) : '<span style="color:var(--text-muted)">无数据</span>'}</span>
            </div>
          `).join('') : '<div style="color:var(--text-muted);font-size:12px">没有依赖变量</div>'}
        </div>
        <div class="mfb-result">当前值 = <b style="color:var(--accent)">${val != null ? round2(val) : '--'}</b> ${esc(m.unit || '')}</div>
      </div>
    `;
  } else {
    const inlineForm = `
      <div class="metric-inline-add">
        <div class="mia-label">+ 添加记录</div>
        <div class="mia-row">
          <input type="number" class="input mia-value" id="inlineValue_${m.id}" placeholder="数值" step="0.1">
          <span class="mia-unit">${esc(m.unit || '')}</span>
          <input type="date" class="input mia-date" id="inlineDate_${m.id}" value="${today()}">
          <button class="btn btn-sm btn-primary mia-btn" data-action="metric-inline-add" data-id="${m.id}" type="button">添加</button>
        </div>
      </div>
    `;
    const historyRows = vals.length ? vals.slice().reverse().map(v => `
      <div class="metric-history-row">
        <span class="metric-history-date">${esc(v.date)}</span>
        <span class="metric-history-value">${v.value} ${esc(m.unit)}</span>
        <div class="metric-history-actions">
          <button class="btn btn-xs btn-ghost" data-action="metric-data-edit" data-id="${v.id}" type="button">✎</button>
          <button class="btn btn-xs btn-danger" data-action="metric-data-del" data-id="${v.id}" type="button">✕</button>
        </div>
      </div>
    `).join('') : '<div class="done-empty">暂无数据</div>';
    bodyHtml = `
      ${inlineForm}
      <div style="margin-top:14px;margin-bottom:6px;font-size:12px;color:var(--text-muted);font-weight:700">历史记录（${vals.length} 条）</div>
      <div class="metric-history-list" style="max-height:44vh;overflow-y:auto;padding-right:4px">${historyRows}</div>
    `;
  }

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <h3 style="font-size:16px;font-weight:800;display:flex;align-items:center;gap:8px">
        <span>📊</span>${esc(m.name)}
        <span style="font-size:12px;color:var(--text-muted);font-weight:600">(${esc(m.unit) || '—'})</span>
        ${m.isDerived ? '<span class="metric-formula-tag" style="font-size:11px">ƒ 公式</span>' : ''}
        ${m.pinned ? '<span style="font-size:11px;color:var(--accent)">📌</span>' : ''}
      </h3>
      <div style="display:flex;gap:6px">
        <button class="btn btn-sm" data-action="metric-toggle-pin" data-id="${m.id}" type="button">${m.pinned ? '取消置顶' : '📌 置顶'}</button>
        <button class="btn btn-sm" data-action="metric-edit" data-id="${m.id}" type="button">⚙️ 编辑</button>
      </div>
    </div>
    <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:12px">
      目标：${hasTarget(m) ? `${m.target_value} ${m.target_dir === 'lower' ? '↓' : '↑'}` : '无'}
    </div>
    ${bodyHtml}
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-sm" data-action="modal-close" type="button">关闭</button>
    </div>
  `;
}

function renderEditModal(m) {
  const isDerived = !!m.isDerived;
  const dir = m.target_dir || 'higher';
  return `
    <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">${isDerived ? 'ƒ 编辑公式指标' : '⚙️ 编辑指标'}</h3>
    <div style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">名称</label>
      <input type="text" class="input" id="meName" value="${esc(m.name)}">
    </div>
    <div style="display:flex;gap:10px;margin-bottom:12px">
      <div style="flex:1">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">单位</label>
        <input type="text" class="input" id="meUnit" value="${esc(m.unit || '')}">
      </div>
      <div style="flex:1">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">目标值</label>
        <input type="number" class="input" id="meTarget" value="${m.target_value || ''}" step="0.1" placeholder="留空=无目标">
      </div>
    </div>
    <div style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">目标方向</label>
      <select class="input" id="meDir">
        <option value="higher"${dir === 'higher' ? ' selected' : ''}>↑ 越高越好（步数、学习时长）</option>
        <option value="lower"${dir === 'lower' ? ' selected' : ''}>↓ 越低越好（体重、BMI）</option>
      </select>
    </div>
    ${isDerived ? `
      <div style="margin-bottom:12px">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">公式</label>
        <input type="text" class="input" id="meFormula" value="${esc(m.formula || '')}" placeholder="例如 体重 / (身高/100)^2" style="font-family:var(--mono);font-size:12px">
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px;line-height:1.6">
          变量用其他指标名（中文或英文）。支持函数 <code>min max abs round floor ceil sqrt pow</code>，指数用 <code>^</code>
        </div>
      </div>
    ` : ''}
    <div style="display:flex;gap:10px;justify-content:space-between;margin-top:16px">
      <button class="btn btn-sm btn-danger" data-action="metric-del" data-id="${m.id}" type="button">🗑️ 删除指标</button>
      <div style="display:flex;gap:10px">
        <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
        <button class="btn btn-sm btn-primary" data-action="metric-edit-save" data-id="${m.id}" type="button">💾 保存</button>
      </div>
    </div>
  `;
}

function renderQuickAddModal() {
  const list = DB.metrics.filter(x => x.user_id === State.user.id && !x.isDerived);
  if (!list.length) {
    return `
      <h3 style="font-size:16px;margin-bottom:12px;font-weight:800">+ 添加数据</h3>
      <div class="done-empty" style="padding:20px">还没有可记录的指标<br><span style="font-size:11.5px">去设置里添加一个普通指标吧</span></div>
      <div style="display:flex;justify-content:flex-end;margin-top:16px">
        <button class="btn btn-sm" data-action="modal-close" type="button">关闭</button>
      </div>
    `;
  }
  const sorted = sortMetrics(list);
  return `
    <h3 style="font-size:16px;margin-bottom:12px;font-weight:800">+ 添加数据</h3>
    <div style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">选择指标</label>
      <select class="input" id="quickMetricId">
        ${sorted.map(m => `<option value="${m.id}"${m.pinned ? ' selected' : ''}>${esc(m.name)}${m.unit ? ' (' + esc(m.unit) + ')' : ''}${m.pinned ? ' 📌' : ''}</option>`).join('')}
      </select>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:12px">
      <div style="flex:1">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">数值</label>
        <input type="number" class="input" id="quickValue" step="0.1" placeholder="0">
      </div>
      <div style="flex:1">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">日期</label>
        <input type="date" class="input" id="quickDate" value="${today()}">
      </div>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
      <button class="btn btn-sm btn-primary" data-action="metric-quick-save" type="button">✓ 添加</button>
    </div>
  `;
}

export const actions = {
  'view-mode': (el) => {
    State.viewMode.metrics = el.dataset.mode;
    import('../../core/db.js').then(({ S }) => S.set('view_mode', State.viewMode));
    rerender();
  },

  'metric-detail': (el) => {
    const m = DB.metrics.find(x => x.id === el.dataset.id);
    if (!m) return;
    showModal('metricDetail', renderDetail(m), 'lg');
  },

  'metric-edit': (el) => {
    const m = DB.metrics.find(x => x.id === el.dataset.id);
    if (!m) return;
    showModal('metricEdit', renderEditModal(m));
  },

  'metric-edit-save': (el) => {
    const m = DB.metrics.find(x => x.id === el.dataset.id);
    if (!m) return;
    const name = document.getElementById('meName').value.trim();
    const unit = document.getElementById('meUnit').value.trim();
    const targetRaw = document.getElementById('meTarget').value.trim();
    const target = targetRaw === '' ? 0 : (parseFloat(targetRaw) || 0);
    const dir = document.getElementById('meDir').value || 'higher';
    if (!name) { toast('名称不能为空', 'warning'); return; }
    if (m.isDerived) {
      const formula = document.getElementById('meFormula').value.trim();
      const v = validateFormula(formula);
      if (!v.ok) { toast('公式错误：' + v.error, 'error'); return; }
      m.formula = formula;
    }
    m.name = name;
    m.unit = unit;
    m.target_value = target;
    m.target_dir = dir;
    save('metrics');
    emit('db:changed');
    hideModal();
    rerender();
    toast('已保存', 'success');
  },

  'metric-del': (el) => {
    const m = DB.metrics.find(x => x.id === el.dataset.id);
    if (!m) return;
    if (!confirm(`删除指标「${m.name}」及其所有数据？`)) return;
    DB.metrics = DB.metrics.filter(x => x.id !== m.id);
    DB.metricValues = DB.metricValues.filter(v => v.metric_id !== m.id);
    save('metrics', 'metricValues');
    emit('db:changed');
    hideModal();
    rerender();
    toast('已删除', 'success');
  },

  'metric-toggle-pin': (el, e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    const m = DB.metrics.find(x => x.id === el.dataset.id);
    if (!m) return;
    m.pinned = !m.pinned;
    save('metrics');
    emit('db:changed');
    rerender();
    toast(m.pinned ? '已置顶' : '已取消置顶', 'success');
  },

  'metric-inline-add': (el) => {
    const mid = el.dataset.id;
    const m = DB.metrics.find(x => x.id === mid);
    if (!m || m.isDerived) return;
    const valEl = document.getElementById('inlineValue_' + mid);
    const dateEl = document.getElementById('inlineDate_' + mid);
    const val = parseFloat(valEl ? valEl.value : '');
    const date = (dateEl && dateEl.value) || today();
    if (isNaN(val)) { toast('请输入数值', 'warning'); if (valEl) valEl.focus(); return; }

    /* ⭐ 只匹配手动录入的记录（无 sourceType），不动 health 写入的 */
    const ex = DB.metricValues.find(v => v.metric_id === mid && v.date === date && !v.sourceType);
    if (ex) {
      const oldVal = ex.value;
      ex.value = val;
      save('metricValues');
      emit('db:changed');
      toast(`已更新 ${m.name}：${oldVal} → ${val}`, 'success');
    } else {
      DB.metricValues.push({ id: uid(), metric_id: mid, date, value: val, createdAt: new Date().toISOString() });
      save('metricValues');
      emit('db:changed');
      toast('已添加', 'success');
    }
    showModal('metricDetail', renderDetail(m), 'lg');
  },

  'metric-quick-add': () => {
    const list = DB.metrics.filter(x => x.user_id === State.user.id && !x.isDerived);
    if (!list.length) { toast('还没有可记录的指标，去设置添加', 'warning'); return; }
    showModal('metricQuickAdd', renderQuickAddModal());
    setTimeout(() => {
      const el = document.getElementById('quickValue');
      if (el) el.focus();
    }, 80);
  },

  'metric-quick-save': () => {
    const sel = document.getElementById('quickMetricId');
    const valEl = document.getElementById('quickValue');
    const dateEl = document.getElementById('quickDate');
    if (!sel || !valEl || !dateEl) return;
    const mid = sel.value;
    const val = parseFloat(valEl.value);
    const date = dateEl.value || today();
    const m = DB.metrics.find(x => x.id === mid);
    if (!m) { toast('指标不存在', 'error'); return; }
    if (isNaN(val)) { toast('请输入数值', 'warning'); valEl.focus(); return; }

    /* ⭐ 只匹配手动录入的记录（无 sourceType），不动 health 写入的 */
    const ex = DB.metricValues.find(v => v.metric_id === mid && v.date === date && !v.sourceType);
    if (ex) {
      const oldVal = ex.value;
      if (oldVal === val) {
        hideModal();
        toast(`${m.name} 今日已是 ${val}`, 'info');
        return;
      }
      ex.value = val;
      save('metricValues');
      emit('db:changed');
      hideModal();
      rerender();
      toast(`已更新 ${m.name}：${oldVal} → ${val}`, 'success');
      return;
    }
    DB.metricValues.push({ id: uid(), metric_id: mid, date, value: val, createdAt: new Date().toISOString() });
    save('metricValues');
    emit('db:changed');
    hideModal();
    rerender();
    toast(`已记录 ${m.name} = ${val}`, 'success');
  },

  'metric-data-edit': (el) => {
    const v = DB.metricValues.find(x => x.id === el.dataset.id);
    if (!v) return;
    const m = DB.metrics.find(x => x.id === v.metric_id);
    if (!m) return;
    showModal('metricDataEdit', `
      <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">✎ 编辑数据点</h3>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">${esc(m.name)} (${esc(m.unit || '')})</div>
      <input type="hidden" id="mdeId" value="${v.id}">
      <div style="margin-bottom:12px">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">数值</label>
        <input type="number" class="input" id="mdeValue2" value="${v.value}" step="0.1">
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">日期</label>
        <input type="date" class="input" id="mdeDate2" value="${v.date}">
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
        <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
        <button class="btn btn-sm btn-primary" data-action="metric-data-edit-save" type="button">💾 保存</button>
      </div>
    `);
  },

  'metric-data-edit-save': () => {
    const idEl = document.getElementById('mdeId');
    if (!idEl) return;
    const v = DB.metricValues.find(x => x.id === idEl.value);
    if (!v) return;
    const d = document.getElementById('mdeDate2').value;
    const val = parseFloat(document.getElementById('mdeValue2').value);
    if (!d || isNaN(val)) { toast('请填写完整', 'warning'); return; }
    v.date = d;
    v.value = val;
    save('metricValues');
    emit('db:changed');
    const m = DB.metrics.find(x => x.id === v.metric_id);
    hideModal();
    if (m) showModal('metricDetail', renderDetail(m), 'lg');
    rerender();
    toast('已保存', 'success');
  },

  'metric-data-del': (el) => {
    const v = DB.metricValues.find(x => x.id === el.dataset.id);
    if (!v) return;
    if (!confirm('删除这条数据？')) return;
    const mid = v.metric_id;
    DB.metricValues = DB.metricValues.filter(x => x.id !== v.id);
    save('metricValues');
    emit('db:changed');
    const m = DB.metrics.find(x => x.id === mid);
    hideModal();
    if (m) showModal('metricDetail', renderDetail(m), 'lg');
    rerender();
    toast('已删除', 'success');
  }
};
/* ⭐ 主题变化时重绘 sparklines（canvas 颜色用 CSS 变量，不重绘会保持旧色） */
window.addEventListener('theme:changed', () => {
  setTimeout(() => {
    try { drawSparklines(); } catch (e) { console.warn('[metric] redraw failed:', e); }
  }, 60);
});