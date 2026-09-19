import { DB, State } from '../../core/db.js';
import { fmtD, addDays, MOOD_SCORE } from '../../core/utils.js';

function roundRectPath(ctx, x, y, w, h, r) {
  if (h < r * 2) r = h / 2;
  if (w < r * 2) r = w / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function toRgba(color, alpha) {
  const c = String(color || '').trim();
  if (c.startsWith('#')) {
    let h = c.slice(1);
    if (h.length === 3) h = h.split('').map(x => x + x).join('');
    if (h.length === 6) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map(s => s.trim());
    return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`;
  }
  return c;
}

function setupCanvas(canvas, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10) return null;
  const w = rect.width;
  const h = cssHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  return { ctx, w, h };
}

/* ============ 1. 专注时长柱状图 ============ */
export function drawFocusBars(canvas) {
  if (!canvas) return;
  const uid = State.user?.id;
  if (!uid) return;

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(new Date(), -i);
    const ds = fmtD(d);
    const minutes = DB.focusSessions
      .filter(f => f.user_id === uid && f.date === ds)
      .reduce((s, f) => s + (f.duration_minutes || 0), 0);
    days.push({ ds, label: `${d.getMonth() + 1}/${d.getDate()}`, value: minutes });
  }

  const setup = setupCanvas(canvas, 150);
  if (!setup) return;
  const { ctx, w, h } = setup;

  const padL = 12, padR = 12, padT = 22, padB = 30;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;

  const max = Math.max(60, ...days.map(d => d.value));
  const slotW = chartW / days.length;
  const gap = 8;
  const barW = slotW - gap;

  const accent = cssVar('--accent', '#7c6cf8');
  const accentH = cssVar('--accent-h', '#9b8cff');
  const muted = cssVar('--text-muted', '#7c7e9c');
  const textSec = cssVar('--text-sec', '#b6b7cf');

  ctx.strokeStyle = 'rgba(128,128,128,.12)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = padT + chartH * (i / 3);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  days.forEach((d, i) => {
    const x = padL + i * slotW + gap / 2;
    const ratio = d.value / max;
    const bh = Math.max(d.value > 0 ? 4 : 2, ratio * chartH);
    const y = padT + chartH - bh;

    if (d.value > 0) {
      const grad = ctx.createLinearGradient(0, y, 0, padT + chartH);
      grad.addColorStop(0, accentH);
      grad.addColorStop(1, accent);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = 'rgba(128,128,128,.18)';
    }
    roundRectPath(ctx, x, y, barW, bh, 5);
    ctx.fill();

    if (d.value > 0) {
      ctx.fillStyle = textSec;
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(String(d.value), x + barW / 2, y - 5);
    }

    ctx.fillStyle = muted;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(d.label, x + barW / 2, padT + chartH + 8);
  });

  ctx.fillStyle = muted;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('分钟', padL, 2);
}

/* ============ 2. 心情折线图 ============ */
let _moodTooltip = null;
function ensureTooltip() {
  if (_moodTooltip) return _moodTooltip;
  const el = document.createElement('div');
  el.className = 'mood-chart-tooltip';
  el.style.cssText = [
    'position:fixed',
    'pointer-events:none',
    'z-index:9999',
    'display:none',
    'background:var(--bg-card-solid)',
    'border:1px solid var(--border-l)',
    'border-radius:10px',
    'padding:10px 14px',
    'font-size:12px',
    'box-shadow:var(--shadow)',
    'font-family:var(--font)',
    'white-space:nowrap',
    'line-height:1.7',
    'transition:opacity .1s'
  ].join(';');
  document.body.appendChild(el);
  _moodTooltip = el;
  return el;
}

let _moodChartCtx = null;

export function drawMoodLine(canvas) {
  if (!canvas) return;
  const uid = State.user?.id;
  if (!uid) return;

  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = addDays(new Date(), -i);
    const ds = fmtD(d);
    const moods = DB.moods.filter(m => m.user_id === uid && m.date === ds);
    if (!moods.length) {
      days.push({ ds, avg: null, min: null, max: null, count: 0 });
    } else {
      const scores = moods.map(m => MOOD_SCORE[m.mood] || 3);
      days.push({
        ds,
        avg: scores.reduce((s, x) => s + x, 0) / scores.length,
        min: Math.min(...scores),
        max: Math.max(...scores),
        count: moods.length
      });
    }
  }

  const setup = setupCanvas(canvas, 170);
  if (!setup) return;
  const { ctx, w, h } = setup;

  const padL = 30, padR = 12, padT = 18, padB = 26;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;

  const accent = cssVar('--accent', '#7c6cf8');
  const muted = cssVar('--text-muted', '#7c7e9c');

  ctx.strokeStyle = 'rgba(128,128,128,.12)';
  ctx.lineWidth = 1;
  ctx.fillStyle = muted;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let s = 1; s <= 5; s++) {
    const y = padT + chartH * (1 - (s - 1) / 4);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText(String(s), padL - 6, y);
  }

  const stepX = days.length > 1 ? chartW / (days.length - 1) : 0;
  const yFor = s => padT + chartH * (1 - (s - 1) / 4);

  const points = [];
  days.forEach((d, i) => {
    if (d.avg === null) return;
    points.push({
      ds: d.ds,
      x: padL + i * stepX,
      yAvg: yFor(d.avg),
      yHigh: yFor(d.max),
      yLow: yFor(d.min),
      avg: d.avg,
      min: d.min,
      max: d.max,
      count: d.count
    });
  });

  if (points.length === 0) {
    ctx.fillStyle = muted;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('近 30 天还没有心情记录', w / 2, h / 2);
    _moodChartCtx = null;
    return;
  }

  const barColor = toRgba(accent, 0.55);
  const barColorLight = toRgba(accent, 0.22);
  points.forEach(p => {
    if (p.max <= p.min) return;
    const barW = 5;
    ctx.fillStyle = barColorLight;
    ctx.fillRect(p.x - barW / 2, p.yHigh, barW, p.yLow - p.yHigh);

    ctx.beginPath();
    ctx.moveTo(p.x, p.yHigh);
    ctx.lineTo(p.x, p.yLow);
    ctx.strokeStyle = barColor;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(p.x - 4, p.yHigh);
    ctx.lineTo(p.x + 4, p.yHigh);
    ctx.strokeStyle = barColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(p.x - 4, p.yLow);
    ctx.lineTo(p.x + 4, p.yLow);
    ctx.strokeStyle = barColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  if (points.length >= 2) {
    const grad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
    grad.addColorStop(0, toRgba(accent, 0.33));
    grad.addColorStop(1, toRgba(accent, 0));
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].yAvg);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].yAvg);
    ctx.lineTo(points[points.length - 1].x, padT + chartH);
    ctx.lineTo(points[0].x, padT + chartH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].yAvg);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].yAvg);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  points.forEach(p => {
    ctx.beginPath();
    ctx.arc(p.x, p.yAvg, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  ctx.fillStyle = muted;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelIdxSet = new Set();
  for (let i = days.length - 1; i >= 0; i -= 7) {
    labelIdxSet.add(i);
  }
  labelIdxSet.forEach(i => {
    const d = days[i];
    if (!d) return;
    const x = padL + i * stepX;
    let align = 'center';
    if (i === 0) align = 'left';
    else if (i === days.length - 1) align = 'right';
    ctx.textAlign = align;
    ctx.fillText(d.ds.slice(5), x, padT + chartH + 6);
  });

  _moodChartCtx = {
    canvas, points, days, padL, padT, chartH, stepX, w, h
  };
  if (!canvas._moodBound) {
    canvas._moodBound = true;
    canvas.addEventListener('mousemove', handleMoodHover);
    canvas.addEventListener('mouseleave', () => {
      if (_moodTooltip) _moodTooltip.style.display = 'none';
    });
  }
}

function handleMoodHover(e) {
  if (!_moodChartCtx) return;
  const { points } = _moodChartCtx;
  const rect = e.target.getBoundingClientRect();
  const mx = e.clientX - rect.left;

  let nearest = null;
  let minDist = 20;
  points.forEach(p => {
    const d = Math.abs(p.x - mx);
    if (d < minDist) {
      minDist = d;
      nearest = p;
    }
  });

  const tip = ensureTooltip();
  if (!nearest) {
    tip.style.display = 'none';
    return;
  }

  const d = new Date(nearest.ds + 'T00:00:00');
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  const dateStr = `${d.getMonth() + 1}月${d.getDate()}日 ${weekday}`;

  const avgStr = nearest.avg.toFixed(1);
  const rangeStr = nearest.max > nearest.min
    ? ` · 范围 ${nearest.min} ~ ${nearest.max}`
    : '';

  tip.innerHTML = `
    <div style="font-weight:800;color:var(--text);margin-bottom:4px">${dateStr}</div>
    <div style="color:var(--text-sec)">
      均值 <b style="color:var(--accent);font-family:var(--mono)">${avgStr}</b>
      · ${nearest.count} 条记录${rangeStr}
    </div>
  `;
  tip.style.display = 'block';

  const tipW = tip.offsetWidth;
  const tipH = tip.offsetHeight;
  const canvasRect = e.target.getBoundingClientRect();
  const globalX = canvasRect.left + nearest.x;
  const globalY = canvasRect.top + nearest.yAvg;

  let left = globalX + 12;
  let top = globalY - tipH - 8;

  if (left + tipW > window.innerWidth - 10) left = globalX - tipW - 12;
  if (top < 10) top = globalY + 12;

  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

/* ============ 3. 习惯一年热力图 ============ */
export function renderHabitHeatmap() {
  const uid = State.user?.id;
  if (!uid) return '';

  const totalHabits = DB.habits.filter(h => h.user_id === uid).length;

  const todayD = new Date();
  todayD.setHours(0, 0, 0, 0);
  const dayOfWeek = todayD.getDay();
  const offsetToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const thisMonday = new Date(todayD);
  thisMonday.setDate(thisMonday.getDate() + offsetToMonday);

  const weeksCount = 53;
  const startMonday = new Date(thisMonday);
  startMonday.setDate(startMonday.getDate() - (weeksCount - 1) * 7);

  const byDate = Object.create(null);
  for (const l of DB.habitLogs) {
    if (l.user_id !== uid) continue;
    byDate[l.date] = (byDate[l.date] || 0) + 1;
  }

  const todayDs = fmtD(todayD);
  const weeks = [];
  for (let w = 0; w < weeksCount; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(startMonday);
      date.setDate(date.getDate() + w * 7 + d);
      const ds = fmtD(date);
      const future = ds > todayDs;
      const logs = byDate[ds] || 0;
      let level = 0;
      if (!future && totalHabits > 0 && logs > 0) {
        level = Math.min(4, Math.max(1, Math.ceil((logs / totalHabits) * 4)));
      }
      week.push({ ds, logs, level, future, isToday: ds === todayDs });
    }
    weeks.push(week);
  }

  const monthLabels = [];
  let lastMonth = -1;
  for (let w = 0; w < weeksCount; w++) {
    const firstDay = new Date(startMonday);
    firstDay.setDate(firstDay.getDate() + w * 7);
    const m = firstDay.getMonth();
    if (m !== lastMonth) {
      monthLabels.push({ w, label: (m + 1) + '月' });
      lastMonth = m;
    }
  }

  const monthCells = Array.from({ length: weeksCount }).map((_, w) => {
    const found = monthLabels.find(x => x.w === w);
    return `<div class="hm-month-cell">${found ? found.label : ''}</div>`;
  }).join('');

  const weekCells = weeks.map(week => `
    <div class="hm-week">
      ${week.map(cell => {
        const cls = ['hm-cell'];
        if (cell.future) cls.push('future');
        else if (cell.level > 0) cls.push('l' + cell.level);
        if (cell.isToday) cls.push('today');
        const title = cell.future ? cell.ds : `${cell.ds} · ${cell.logs} 次打卡`;
        return `<div class="${cls.join(' ')}" title="${title}"></div>`;
      }).join('')}
    </div>
  `).join('');

  const hint = totalHabits === 0
    ? '<div class="hm-empty-hint">还没有习惯，先去「习惯与目标」添加一个吧 🌱</div>'
    : '';

  return `
    <div class="hm-wrap">
      <div class="hm-months">${monthCells}</div>
      <div class="hm-body">
        <div class="hm-weekdays">
          <div>一</div><div></div><div>三</div><div></div><div>五</div><div></div><div>日</div>
        </div>
        <div class="hm-grid">${weekCells}</div>
      </div>
      <div class="hm-legend">
        <span>少</span>
        <div class="hm-cell"></div>
        <div class="hm-cell l1"></div>
        <div class="hm-cell l2"></div>
        <div class="hm-cell l3"></div>
        <div class="hm-cell l4"></div>
        <span>多</span>
      </div>
      ${hint}
    </div>`;
}

/* ================================================================
 * ⭐ 健康图表（近 7 天）
 * ================================================================ */

function getHealthDayValues(type) {
  const uid = State.user?.id;
  if (!uid) return [];
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(new Date(), -i);
    const ds = fmtD(d);
    let value = 0;
    const recs = (DB.healthRecords || []).filter(r => r.user_id === uid && r.date === ds && r.type === type);
    if (type === 'diet') {
      value = recs.reduce((s, r) => s + (r.calories || r.value || 0), 0);
    } else {
      value = recs.reduce((s, r) => s + (r.value || 0), 0);
    }
    days.push({ ds, label: `${d.getMonth() + 1}/${d.getDate()}`, value });
  }
  return days;
}

function drawHealthBars(canvas, days, opts) {
  if (!canvas) return;
  const setup = setupCanvas(canvas, opts.height || 150);
  if (!setup) return;
  const { ctx, w, h } = setup;

  const padL = 12, padR = 12, padT = 22, padB = 30;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;

  const max = Math.max(opts.minMax || 5, ...days.map(d => d.value));
  const slotW = chartW / days.length;
  const gap = 8;
  const barW = slotW - gap;

  const accent = opts.color || cssVar('--accent', '#7c6cf8');
  const accentH = opts.colorH || accent;
  const muted = cssVar('--text-muted', '#7c7e9c');
  const textSec = cssVar('--text-sec', '#b6b7cf');

  ctx.strokeStyle = 'rgba(128,128,128,.12)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = padT + chartH * (i / 3);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  days.forEach((d, i) => {
    const x = padL + i * slotW + gap / 2;
    const ratio = max > 0 ? d.value / max : 0;
    const bh = Math.max(d.value > 0 ? 4 : 2, ratio * chartH);
    const y = padT + chartH - bh;

    if (d.value > 0) {
      const grad = ctx.createLinearGradient(0, y, 0, padT + chartH);
      grad.addColorStop(0, accentH);
      grad.addColorStop(1, accent);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = 'rgba(128,128,128,.18)';
    }
    roundRectPath(ctx, x, y, barW, bh, 5);
    ctx.fill();

    if (d.value > 0) {
      ctx.fillStyle = textSec;
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(opts.fmt ? opts.fmt(d.value) : String(Math.round(d.value)), x + barW / 2, y - 5);
    }

    ctx.fillStyle = muted;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(d.label, x + barW / 2, padT + chartH + 8);
  });

  ctx.fillStyle = muted;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(opts.unit || '', padL, 2);
}

export function drawHealthSleepBars(canvas) {
  if (!canvas) return;
  const days = getHealthDayValues('sleep');
  drawHealthBars(canvas, days, {
    color: '#7c6cf8', colorH: '#9b8cff',
    unit: '小时', height: 150,
    fmt: v => v.toFixed(1)
  });
}

export function drawHealthWaterBars(canvas) {
  if (!canvas) return;
  const days = getHealthDayValues('water');
  drawHealthBars(canvas, days, {
    color: '#60a5fa', colorH: '#93c5fd',
    unit: 'ml', height: 150,
    fmt: v => String(Math.round(v))
  });
}

export function drawHealthCalBars(canvas) {
  if (!canvas) return;
  const days = getHealthDayValues('diet');
  drawHealthBars(canvas, days, {
    color: '#f59e0b', colorH: '#fbbf24',
    unit: 'kcal', height: 150,
    fmt: v => String(Math.round(v))
  });
}

export function drawHealthExBars(canvas) {
  if (!canvas) return;
  const days = getHealthDayValues('exercise');
  drawHealthBars(canvas, days, {
    color: '#4ade80', colorH: '#86efac',
    unit: '分钟', height: 150,
    fmt: v => String(Math.round(v))
  });
}