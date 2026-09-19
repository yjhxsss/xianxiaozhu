import { DB, State } from '../../core/db.js';
import { esc } from '../../core/utils.js';
import { MAX_STAGE } from './algorithm.js';

/* ============ 工具 ============ */
function localDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
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

/* ============ ⭐ 累计学习曲线：每天结束时累计学过的卡片数 ============ */
function computeLearningCurve(logs, cards, dayList) {
  /* 每张卡片的"首次复习日期" */
  const firstSeen = {};
  logs.forEach(l => {
    if (!l.card_id) return;
    if (!firstSeen[l.card_id] || l.date < firstSeen[l.card_id]) {
      firstSeen[l.card_id] = l.date;
    }
  });

  const startDs = dayList[0].ds;
  const byDate = {};
  let baseline = 0;

  Object.keys(firstSeen).forEach(cardId => {
    const date = firstSeen[cardId];
    if (date < startDs) baseline++;
    else byDate[date] = (byDate[date] || 0) + 1;
  });

  let running = baseline;
  return dayList.map(day => {
    running += (byDate[day.ds] || 0);
    return { ds: day.ds, value: running };
  });
}

/* ============ 收集数据 ============ */
function collectStats() {
  const uid = State.user.id;
  const logs = DB.reviewLogs.filter(l => l.user_id === uid);
  const cards = DB.cards.filter(c => c.user_id === uid);
  const decks = DB.decks.filter(d => d.user_id === uid);

  /* 近 30 天 */
  const now = new Date();
  const dayList = [];
  for (let i = 29; i >= 0; i--) {
    const d = addDays(now, -i);
    dayList.push({
      ds: localDate(d),
      label: `${d.getMonth() + 1}/${d.getDate()}`
    });
  }

  /* 每天复习次数 */
  const days = dayList.map(d => {
    const dayLogs = logs.filter(l => l.date === d.ds);
    const unique = new Set(dayLogs.map(l => l.card_id));
    return {
      ds: d.ds,
      label: d.label,
      count: dayLogs.length,
      uniqueCards: unique.size
    };
  });

  /* ⭐ 累计学习曲线 */
  const cumulative = computeLearningCurve(logs, cards, dayList);

  /* 各卡片组统计 */
  const deckStats = decks.map(d => {
    const dcards = cards.filter(c => c.deck_id === d.id);
    const mastered = dcards.filter(c => c.mastered).length;
    const total = dcards.length;
    const errors = dcards.filter(c => (c.wrongCount || 0) > 0).length;
    return {
      id: d.id,
      name: d.name,
      color: d.color || '#7c6cf8',
      total,
      mastered,
      errors,
      pct: total ? Math.round(mastered / total * 100) : 0
    };
  }).sort((a, b) => b.total - a.total);

  /* 模式分布 */
  const modes = { review: 0, dictation: 0, quiz: 0 };
  logs.forEach(l => {
    if (l.mode === 'dictation') modes.dictation++;
    else if (l.mode === 'quiz') modes.quiz++;
    else modes.review++;
  });

  /* 评分分布 */
  const ratings = { 1: 0, 2: 0, 3: 0 };
  logs.forEach(l => {
    if (ratings[l.rating] !== undefined) ratings[l.rating]++;
  });

  /* 学习卡片总数（至少复习过一次） */
  const learnedCardIds = new Set(logs.map(l => l.card_id).filter(Boolean));
  const learnedCount = cards.filter(c => learnedCardIds.has(c.id)).length;

  return {
    days, cumulative,
    deckStats, modes, ratings,
    totalLogs: logs.length,
    totalCards: cards.length,
    totalMastered: cards.filter(c => c.mastered).length,
    totalErrors: cards.filter(c => (c.wrongCount || 0) > 0).length,
    totalDecks: decks.length,
    learnedCount
  };
}

/* ============ 渲染 ============ */
export function renderStats() {
  const s = collectStats();

  const estimatedMin = Math.round(s.totalLogs * 15 / 60);
  const totalRated = s.ratings[1] + s.ratings[2] + s.ratings[3];
  const accuracy = totalRated ? Math.round((s.ratings[2] + s.ratings[3]) / totalRated * 100) : 0;

  let html = `
    <div class="panel">
      <div class="panel-title">
        <button class="btn btn-sm" data-action="stats-back" type="button">← 返回</button>
        <span class="title-icon" style="margin-left:10px">📊</span>
        <span style="font-weight:800">学习统计</span>
      </div>

      <div class="stats-overview-grid">
        <div class="sog-item">
          <div class="sog-icon">🔁</div>
          <div class="sog-info">
            <div class="sog-num">${s.totalLogs}</div>
            <div class="sog-label">累计复习</div>
          </div>
        </div>
        <div class="sog-item">
          <div class="sog-icon">⏱️</div>
          <div class="sog-info">
            <div class="sog-num">${estimatedMin}<span class="sog-unit">分</span></div>
            <div class="sog-label">学习时长</div>
          </div>
        </div>
        <div class="sog-item">
          <div class="sog-icon">✅</div>
          <div class="sog-info">
            <div class="sog-num">${s.totalMastered}<span class="sog-unit">/${s.totalCards}</span></div>
            <div class="sog-label">已掌握卡片</div>
          </div>
        </div>
        <div class="sog-item">
          <div class="sog-icon">🎯</div>
          <div class="sog-info">
            <div class="sog-num">${accuracy}<span class="sog-unit">%</span></div>
            <div class="sog-label">平均正确率</div>
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-title"><span class="title-icon">📅</span>近 30 天复习量</div>
      <div class="stats-chart-wrap">
        <canvas id="statsDailyChart" style="height:180px"></canvas>
      </div>
      <div class="stats-chart-legend">
        <span class="scl-dot accent"></span><span>每日复习次数</span>
      </div>
    </div>

    <div class="panel">
      <div class="panel-title"><span class="title-icon">📈</span>累计学习进度</div>
      <div class="stats-chart-wrap">
        <canvas id="statsCumulativeChart" style="height:180px"></canvas>
      </div>
      <div class="stats-chart-legend">
        <span class="scl-dot success"></span><span>累计学过的卡片数（共 ${s.totalCards} 张）</span>
      </div>
    </div>

    <div class="home-row home-row-2">
      <div class="panel">
        <div class="panel-title"><span class="title-icon">🎲</span>学习模式分布</div>
        ${renderModeDistribution(s.modes)}
      </div>

      <div class="panel">
        <div class="panel-title"><span class="title-icon">⭐</span>评分分布</div>
        ${renderRatingDistribution(s.ratings)}
      </div>
    </div>

    <div class="panel">
      <div class="panel-title"><span class="title-icon">📚</span>各卡片组进度</div>
      ${renderDeckProgress(s.deckStats)}
    </div>
  `;

  return html;
}

function renderModeDistribution(modes) {
  const total = modes.review + modes.dictation + modes.quiz;
  if (!total) return '<div class="done-empty">暂无数据</div>';

  const items = [
    { key: 'review',    label: '📖 复习',   count: modes.review,    color: 'var(--accent)' },
    { key: 'dictation', label: '✍️ 默写',   count: modes.dictation, color: 'var(--info)' },
    { key: 'quiz',      label: '🎲 测试',   count: modes.quiz,      color: 'var(--warning)' }
  ];

  return `<div class="stats-dist-list">
    ${items.map(item => {
      const pct = total ? Math.round(item.count / total * 100) : 0;
      return `
        <div class="sdl-row">
          <div class="sdl-label">${item.label}</div>
          <div class="sdl-bar-wrap">
            <div class="sdl-bar-fill" style="width:${pct}%;background:${item.color}"></div>
          </div>
          <div class="sdl-value">${item.count} <span class="sdl-pct">${pct}%</span></div>
        </div>`;
    }).join('')}
  </div>`;
}

function renderRatingDistribution(ratings) {
  const total = ratings[1] + ratings[2] + ratings[3];
  if (!total) return '<div class="done-empty">暂无数据</div>';

  const items = [
    { key: '3', label: '😄 会',   count: ratings[3], color: 'var(--success)' },
    { key: '2', label: '😐 模糊', count: ratings[2], color: 'var(--warning)' },
    { key: '1', label: '😵 不会', count: ratings[1], color: 'var(--danger)' }
  ];

  return `<div class="stats-dist-list">
    ${items.map(item => {
      const pct = total ? Math.round(item.count / total * 100) : 0;
      return `
        <div class="sdl-row">
          <div class="sdl-label">${item.label}</div>
          <div class="sdl-bar-wrap">
            <div class="sdl-bar-fill" style="width:${pct}%;background:${item.color}"></div>
          </div>
          <div class="sdl-value">${item.count} <span class="sdl-pct">${pct}%</span></div>
        </div>`;
    }).join('')}
  </div>`;
}

function renderDeckProgress(deckStats) {
  if (!deckStats.length) return '<div class="done-empty">暂无卡片组</div>';

  return `<div class="deck-progress-list">
    ${deckStats.map(d => `
      <div class="dpl-row">
        <div class="dpl-color" style="background:${d.color}"></div>
        <div class="dpl-main">
          <div class="dpl-head">
            <span class="dpl-name">${esc(d.name)}</span>
            <span class="dpl-meta">${d.mastered}/${d.total} · ${d.pct}%${d.errors > 0 ? ` · <span style="color:var(--danger)">❌${d.errors}</span>` : ''}</span>
          </div>
          <div class="dpl-bar">
            <div class="dpl-fill" style="width:${d.pct}%;background:${d.color}"></div>
          </div>
        </div>
      </div>
    `).join('')}
  </div>`;
}

/* ============ Canvas 绘制 ============ */
export function afterMount() {
  requestAnimationFrame(() => {
    const s = collectStats();
    drawDailyBars(document.getElementById('statsDailyChart'), s.days);
    drawCumulativeLine(document.getElementById('statsCumulativeChart'), s.cumulative, s.totalCards);
  });
}

/* 每日复习柱状图 */
function drawDailyBars(canvas, days) {
  if (!canvas || !days.length) return;
  const setup = setupCanvas(canvas, 180);
  if (!setup) return;
  const { ctx, w, h } = setup;

  const padL = 30, padR = 10, padT = 16, padB = 26;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;

  const accent = cssVar('--accent', '#7c6cf8');
  const accentH = cssVar('--accent-h', '#9b8cff');
  const muted = cssVar('--text-muted', '#7c7e9c');

  const max = Math.max(5, ...days.map(d => d.count));

  ctx.strokeStyle = 'rgba(128,128,128,.1)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = padT + chartH * (i / 3);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }
  ctx.fillStyle = muted;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(max), padL - 6, padT);
  ctx.fillText('0', padL - 6, padT + chartH);

  const slotW = chartW / days.length;
  const gap = Math.max(2, slotW * 0.25);
  const barW = Math.max(2, slotW - gap);

  days.forEach((d, i) => {
    const x = padL + i * slotW + gap / 2;
    const ratio = d.count / max;
    const bh = Math.max(d.count > 0 ? 3 : 1, ratio * chartH);
    const y = padT + chartH - bh;

    if (d.count > 0) {
      const grad = ctx.createLinearGradient(0, y, 0, padT + chartH);
      grad.addColorStop(0, accentH);
      grad.addColorStop(1, accent);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = 'rgba(128,128,128,.15)';
    }
    const r = Math.min(3, barW / 2, bh / 2);
    ctx.beginPath();
    if (bh < 4) {
      ctx.rect(x, y, barW, bh);
    } else {
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + barW - r, y);
      ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
      ctx.lineTo(x + barW, y + bh - r);
      ctx.quadraticCurveTo(x + barW, y + bh, x + barW - r, y + bh);
      ctx.lineTo(x + r, y + bh);
      ctx.quadraticCurveTo(x, y + bh, x, y + bh - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }
    ctx.fill();

    if (i === days.length - 1) {
      ctx.strokeStyle = accentH;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  });

  ctx.fillStyle = muted;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i < days.length; i += 7) {
    const d = days[i];
    const x = padL + i * slotW + slotW / 2;
    ctx.fillText(d.ds.slice(5), x, padT + chartH + 6);
  }
  const lastDay = days[days.length - 1];
  const lastX = padL + (days.length - 1) * slotW + slotW / 2;
  ctx.fillText(lastDay.ds.slice(5), lastX, padT + chartH + 6);
}

/* ⭐ 累计学习曲线 */
function drawCumulativeLine(canvas, cumulative, totalCards) {
  if (!canvas || !cumulative.length) return;
  const setup = setupCanvas(canvas, 180);
  if (!setup) return;
  const { ctx, w, h } = setup;

  const padL = 38, padR = 10, padT = 16, padB = 26;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;

  const success = cssVar('--success', '#4ade80');
  const muted = cssVar('--text-muted', '#7c7e9c');
  const textSec = cssVar('--text-sec', '#b6b7cf');

  const values = cumulative.map(c => c.value);
  /* y 轴范围：0 到 max(卡片总数, 曲线最大值)，保证纵轴有意义的刻度 */
  const maxVal = Math.max(5, ...values);
  const yMax = Math.ceil(maxVal / 5) * 5;
  const yMin = 0;

  /* 参考线 */
  ctx.strokeStyle = 'rgba(128,128,128,.1)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = padT + chartH * (i / 3);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }
  /* y 轴数值 */
  ctx.fillStyle = muted;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 3; i++) {
    const v = Math.round(yMax - (yMax - yMin) * i / 3);
    const y = padT + chartH * (i / 3);
    ctx.fillText(String(v), padL - 6, y);
  }

  const n = cumulative.length;
  const stepX = n > 1 ? chartW / (n - 1) : 0;
  const yFor = v => padT + chartH * (1 - (v - yMin) / (yMax - yMin || 1));

  const points = cumulative.map((c, i) => ({ x: padL + i * stepX, y: yFor(c.value), v: c.value }));

  /* 面积 */
  const grad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
  grad.addColorStop(0, toRgba(success, 0.35));
  grad.addColorStop(1, toRgba(success, 0));
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.lineTo(points[points.length - 1].x, padT + chartH);
  ctx.lineTo(points[0].x, padT + chartH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  /* 折线 */
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.strokeStyle = success;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  /* 最后一个点 + 数值 */
  const last = points[points.length - 1];
  if (last) {
    ctx.beginPath();
    ctx.arc(last.x, last.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = success;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.7)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = success;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(String(last.v), last.x - 6, last.y - 6);
  }

  /* 首尾显示卡片总数 */
  if (totalCards) {
    ctx.fillStyle = textSec;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`共 ${totalCards} 张`, padL, 2);
  }

  /* x 轴标签 */
  ctx.fillStyle = muted;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i < cumulative.length; i += 7) {
    const c = cumulative[i];
    const x = padL + i * stepX;
    ctx.fillText(c.ds.slice(5), x, padT + chartH + 6);
  }
  const lastX = padL + (cumulative.length - 1) * stepX;
  ctx.fillText(cumulative[cumulative.length - 1].ds.slice(5), lastX, padT + chartH + 6);
}

/* ============ Actions ============ */
export const actions = {
  'stats-open': () => {
    State.reviewView = 'stats';
    State.reviewDeckId = null;
    rerenderWrap();
  },
  'stats-back': () => {
    State.reviewView = 'main';
    rerenderWrap();
  }
};

function rerenderWrap() {
  import('../../ui/shell.js').then(m => m.rerender());
}
/* ⭐ 主题变化时重绘统计图表 */
window.addEventListener('theme:changed', () => {
  setTimeout(() => {
    try { afterMount(); } catch (e) { console.warn('[stats] redraw failed:', e); }
  }, 60);
});