import { DB, State, save } from '../../core/db.js';
import { esc, uid, today } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';
import { applyRating, STAGES, MAX_STAGE } from './algorithm.js';

/* ============ 开始复习 ============ */
export function startReview(deckId) {
  const now = Date.now();
  let cards;
  let deckName;

  if (deckId === '__all__') {
    cards = DB.cards.filter(c => c.user_id === State.user.id && !c.mastered && (c.nextReview || 0) <= now);
    deckName = '全部';
  } else if (deckId === '__errors__') {
    /* ⭐ 错题本：所有 wrongCount > 0 的卡片，不受 nextReview 限制 */
    cards = DB.cards.filter(c => c.user_id === State.user.id && (c.wrongCount || 0) > 0);
    /* 按错误次数降序 */
    cards.sort((a, b) => (b.wrongCount || 0) - (a.wrongCount || 0));
    deckName = '错题本';
  } else {
    cards = DB.cards.filter(c => c.user_id === State.user.id && c.deck_id === deckId && !c.mastered && (c.nextReview || 0) <= now);
    const d = DB.decks.find(x => x.id === deckId);
    deckName = d ? d.name : '卡片组';
  }

  if (!cards.length) {
    toast('当前没有待复习的卡片', 'info');
    return;
  }

  if (deckId !== '__errors__') {
    cards.sort((a, b) => (a.nextReview || 0) - (b.nextReview || 0));
  }

  State.reviewSession = {
    deckId,
    deckName,
    cardIds: cards.map(c => c.id),
    currentIdx: 0,
    showAnswer: false,
    results: []
  };
  renderSession();
}

/* ============ 渲染复习界面 ============ */
export function renderSession() {
  const s = State.reviewSession;
  if (!s) return;

  const old = document.getElementById('reviewOverlay');
  if (old) old.remove();

  if (s.currentIdx >= s.cardIds.length) {
    renderResult();
    return;
  }

  const card = DB.cards.find(c => c.id === s.cardIds[s.currentIdx]);
  if (!card) {
    s.currentIdx++;
    renderSession();
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = 'reviewOverlay';
  overlay.className = 'review-overlay';
  overlay.innerHTML = `
    <div class="review-panel">
      <div class="review-head">
        <div class="review-deck-name">${esc(s.deckName)}</div>
        <div class="review-progress">${s.currentIdx + 1} / ${s.cardIds.length}</div>
        <button class="review-exit" data-action="review-exit" type="button" title="退出">✕</button>
      </div>
      <div class="review-progress-bar">
        <div class="review-progress-fill" style="width:${(s.currentIdx / s.cardIds.length) * 100}%"></div>
      </div>

      <div class="review-body" data-action="review-flip" role="button">
        <div class="review-card">
          <div class="review-card-front">${formatText(card.front)}</div>
          ${s.showAnswer ? `
            <div class="review-card-divider"></div>
            <div class="review-card-back">${formatText(card.back)}</div>
            ${card.example ? `<div class="review-card-example">${formatText(card.example)}</div>` : ''}
          ` : ''}
        </div>
        ${!s.showAnswer ? `
          <div class="review-hint">点击卡片显示答案（或按空格）</div>
        ` : ''}
      </div>

      ${s.showAnswer ? `
        <div class="review-actions">
          <button class="review-btn review-btn-again" data-action="review-rate" data-rating="1" type="button">
            <span class="rb-icon">😵</span>
            <span class="rb-label">不会</span>
            <span class="rb-hint">5 分钟后</span>
          </button>
          <button class="review-btn review-btn-hard" data-action="review-rate" data-rating="2" type="button">
            <span class="rb-icon">😐</span>
            <span class="rb-label">模糊</span>
            <span class="rb-hint">${getHintText(card, 2)}</span>
          </button>
          <button class="review-btn review-btn-good" data-action="review-rate" data-rating="3" type="button">
            <span class="rb-icon">😄</span>
            <span class="rb-label">会</span>
            <span class="rb-hint">${getHintText(card, 3)}</span>
          </button>
        </div>
        <div class="review-tip">💡 按 1 / 2 / 3 快速评分</div>
      ` : `
        <div class="review-actions-placeholder"></div>
      `}
    </div>
  `;
  document.body.appendChild(overlay);
}

function getHintText(card, rating) {
  let stage = card.stage || 0;
  if (rating === 1) stage = 0;
  else if (rating === 2) stage = Math.max(0, stage - 1);
  else stage = Math.min(MAX_STAGE, stage + 1);
  return STAGES[stage].label + '后';
}

function formatText(t) {
  return esc(String(t || '')).replace(/\n/g, '<br>');
}

/* ============ 评分 ============ */
export function rateCard(rating) {
  const s = State.reviewSession;
  if (!s) return;
  const card = DB.cards.find(c => c.id === s.cardIds[s.currentIdx]);
  if (!card) { s.currentIdx++; renderSession(); return; }

  const prevStage = card.stage || 0;
  applyRating(card, rating);

  DB.reviewLogs.push({
    id: uid(),
    user_id: State.user.id,
    card_id: card.id,
    deck_id: card.deck_id,
    date: today(),
    rating,
    prevStage,
    nextStage: card.stage,
    reviewedAt: new Date().toISOString()
  });

  s.results.push({ cardId: card.id, rating, prevStage, nextStage: card.stage });
  s.currentIdx++;
  s.showAnswer = false;

  save('cards', 'reviewLogs');
  emit('db:changed');
  renderSession();
}

/* ============ 结果页 ============ */
function renderResult() {
  const s = State.reviewSession;
  if (!s) return;

  const total = s.results.length;
  const again = s.results.filter(r => r.rating === 1).length;
  const hard = s.results.filter(r => r.rating === 2).length;
  const good = s.results.filter(r => r.rating === 3).length;

  const overlay = document.createElement('div');
  overlay.id = 'reviewOverlay';
  overlay.className = 'review-overlay';
  overlay.innerHTML = `
    <div class="review-panel review-result-panel">
      <div class="review-result">
        <div class="review-result-icon">🎉</div>
        <div class="review-result-title">本轮复习完成</div>
        <div class="review-result-sub">${esc(s.deckName)}</div>

        <div class="review-result-stats">
          <div class="rrs-item"><span class="rrs-num">${total}</span><span class="rrs-label">总计</span></div>
          <div class="rrs-item rrs-again"><span class="rrs-num">${again}</span><span class="rrs-label">😵 不会</span></div>
          <div class="rrs-item rrs-hard"><span class="rrs-num">${hard}</span><span class="rrs-label">😐 模糊</span></div>
          <div class="rrs-item rrs-good"><span class="rrs-num">${good}</span><span class="rrs-label">😄 会</span></div>
        </div>

        <div class="review-result-tip">
          ${good === total && total > 0 ? '太棒了，全部掌握 💪' :
            again > 0 ? `有 ${again} 张需要重新巩固，5 分钟后会再次出现` :
            '继续保持！'}
        </div>

        <div class="review-result-actions">
          <button class="btn btn-primary" data-action="review-finish" type="button">完成</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function exitReview() {
  State.reviewSession = null;
  const old = document.getElementById('reviewOverlay');
  if (old) old.remove();
  rerender();
}

export const actions = {
  'review-start': (el) => {
    startReview(el.dataset.id);
  },

  'review-start-all': () => {
    startReview('__all__');
  },

  'review-flip': () => {
    const s = State.reviewSession;
    if (!s) return;
    s.showAnswer = true;
    renderSession();
  },

  'review-rate': (el) => {
    const rating = parseInt(el.dataset.rating);
    if (!rating) return;
    rateCard(rating);
  },

  'review-exit': () => {
    const s = State.reviewSession;
    if (s && s.currentIdx > 0 && s.currentIdx < s.cardIds.length) {
      if (!confirm('退出复习？已完成的进度会保存')) return;
    }
    exitReview();
  },

  'review-finish': () => {
    exitReview();
  }
};

document.addEventListener('keydown', e => {
  const s = State.reviewSession;
  if (!s) return;
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;

  if (e.key === ' ' || e.key === 'Enter') {
    if (!s.showAnswer) {
      e.preventDefault();
      actions['review-flip']();
    }
  } else if (s.showAnswer) {
    if (e.key === '1') { e.preventDefault(); rateCard(1); }
    else if (e.key === '2') { e.preventDefault(); rateCard(2); }
    else if (e.key === '3') { e.preventDefault(); rateCard(3); }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    actions['review-exit']();
  }
});
// END OF FILE