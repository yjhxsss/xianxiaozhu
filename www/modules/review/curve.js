import { STAGES, MAX_STAGE } from './algorithm.js';

/* ============ 单张卡片的背诵曲线（SVG） ============ */
export function renderCurveSVG(card) {
  const stage = card.stage || 0;
  const mastered = !!card.mastered;

  const W = 520, H = 170;
  const padL = 20, padR = 20, padT = 40, padB = 40;
  const chartW = W - padL - padR;
  const n = STAGES.length;   /* 8 */
  const stepX = chartW / (n - 1);

  const yFor = s => padT + (H - padT - padB) * (1 - s / MAX_STAGE);

  const nodes = STAGES.map((st, i) => ({
    i,
    x: padL + i * stepX,
    y: yFor(i),
    label: st.label,
    done: i < stage || (mastered && i === stage),
    current: i === stage && !mastered,
    masteredNode: mastered && i === MAX_STAGE
  }));

  /* 已完成部分用实线，未来部分用虚线 */
  const doneNodes = nodes.filter(n => n.done);
  const futureNodes = nodes.filter(n => !n.done && !n.current);
  const currentNode = nodes.find(n => n.current);

  /* 实线路径 */
  let donePath = '';
  if (doneNodes.length >= 2) {
    donePath = doneNodes.map((n, i) => (i === 0 ? `M ${n.x} ${n.y}` : `L ${n.x} ${n.y}`)).join(' ');
  } else if (doneNodes.length === 1) {
    donePath = `M ${doneNodes[0].x} ${doneNodes[0].y} L ${doneNodes[0].x + 0.001} ${doneNodes[0].y}`;
  }

  /* 虚线路径（从当前点到最后一个节点） */
  let futurePath = '';
  const futureChain = [...(currentNode ? [currentNode] : []), ...futureNodes];
  if (futureChain.length >= 2) {
    futurePath = futureChain.map((n, i) => (i === 0 ? `M ${n.x} ${n.y}` : `L ${n.x} ${n.y}`)).join(' ');
  }

  /* 每个节点 */
  const nodeSvg = nodes.map(n => {
    let fill = 'var(--bg-card-solid)';
    let stroke = 'var(--border-l)';
    let radius = 6;
    let glow = '';
    if (n.done) { fill = 'var(--accent)'; stroke = 'var(--accent)'; }
    if (n.current) {
      fill = 'var(--accent)';
      stroke = 'var(--accent-h)';
      radius = 8;
      glow = `<circle cx="${n.x}" cy="${n.y}" r="14" fill="none" stroke="var(--accent)" stroke-width="2" opacity="0.35">
        <animate attributeName="r" values="10;18;10" dur="1.8s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="0.5;0;0.5" dur="1.8s" repeatCount="indefinite"/>
      </circle>`;
    }
    if (n.masteredNode) {
      fill = 'var(--success)';
      stroke = 'var(--success)';
      radius = 9;
    }

    /* 标签：偶数下标标在上方，奇数标在下方，避免挤在一起 */
    const labelAbove = n.i % 2 === 0;
    const labelY = labelAbove ? n.y - 14 : n.y + 20;
    const labelColor = n.done || n.current ? 'var(--text)' : 'var(--text-muted)';
    const labelWeight = n.current ? 800 : 600;

    return `${glow}
      <circle cx="${n.x}" cy="${n.y}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
      <text x="${n.x}" y="${labelY}" text-anchor="middle" fill="${labelColor}"
            font-size="10.5" font-weight="${labelWeight}" font-family="var(--mono)">
        ${n.label}
      </text>
      ${n.i === MAX_STAGE ? `
        <text x="${n.x}" y="${n.y + 34}" text-anchor="middle" fill="${n.masteredNode ? 'var(--success)' : 'var(--text-muted)'}"
              font-size="10" font-weight="700">掌握</text>
      ` : ''}
    `;
  }).join('');

  /* 进度和状态文字 */
  const statusText = mastered
    ? '已掌握 · 完成所有阶段 🎉'
    : (stage === 0 ? '未开始' : `第 ${stage} / ${MAX_STAGE} 阶段`);

  return `
    <div class="curve-wrap">
      <svg viewBox="0 0 ${W} ${H}" class="curve-svg" preserveAspectRatio="xMidYMid meet">
        ${donePath ? `<path d="${donePath}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"/>` : ''}
        ${futurePath ? `<path d="${futurePath}" fill="none" stroke="var(--border-l)" stroke-width="2" stroke-dasharray="5 4"/>` : ''}
        ${nodeSvg}
      </svg>
      <div class="curve-status">${statusText}</div>
    </div>
  `;
}

/* ============ 曲线弹窗 ============ */
import { show as showModal } from '../../ui/modal.js';
import { esc, localTime } from '../../core/utils.js';
import { humanNextReview } from './algorithm.js';

export function showCurveModal(card) {
  if (!card) return;

  /* 复习历史 */
  const logs = (window.__app && window.__app.DB ? window.__app.DB.reviewLogs : [])
    .filter(l => l.card_id === card.id)
    .slice(-10)
    .reverse();

  const ratingLabel = r => ({ 1: '😵 不会', 2: '😐 模糊', 3: '😄 会' }[r] || r);

  const historyHtml = logs.length ? `
    <div class="curve-history">
      <div class="curve-history-title">复习历史（最近 ${logs.length} 次）</div>
      ${logs.map(l => `
        <div class="curve-history-row">
          <span class="chr-time">${esc(l.reviewedAt ? localTime(l.reviewedAt) : '')}</span>
          <span class="chr-rating">${ratingLabel(l.rating)}</span>
          <span class="chr-stage">阶段 ${l.prevStage || 0} → ${l.nextStage || 0}</span>
        </div>
      `).join('')}
    </div>
  ` : '<div class="curve-history-empty">还没有复习记录</div>';

  showModal('cardCurve', `
    <h3 style="font-size:16px;margin-bottom:6px;font-weight:800">📈 背诵曲线</h3>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px;line-height:1.5">
      <b style="color:var(--text)">${esc(card.front.slice(0, 60))}</b>
    </div>

    ${renderCurveSVG(card)}

    <div class="curve-info">
      <div class="curve-info-row">
        <span>当前阶段</span>
        <b>${card.stage || 0} / ${MAX_STAGE}</b>
      </div>
      <div class="curve-info-row">
        <span>下次复习</span>
        <b>${humanNextReview(card)}</b>
      </div>
      <div class="curve-info-row">
        <span>累计复习</span>
        <b>${card.reviewCount || 0} 次</b>
      </div>
    </div>

    ${historyHtml}

    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-sm" data-action="modal-close" type="button">关闭</button>
    </div>
  `, 'lg');
}
// END OF FILE