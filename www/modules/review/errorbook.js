import { DB, State, save } from '../../core/db.js';
import { esc, today } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';
import { showCurveModal } from './curve.js';
import { MAX_STAGE } from './algorithm.js';

/* ============ 错题本视图 ============ */
export function renderErrorBook() {
  const cards = DB.cards.filter(c => c.user_id === State.user.id && (c.wrongCount || 0) > 0);

  /* 按 wrongCount 降序 */
  cards.sort((a, b) => (b.wrongCount || 0) - (a.wrongCount || 0));

  /* 分组统计 */
  const byDeck = {};
  cards.forEach(c => {
    if (!byDeck[c.deck_id]) byDeck[c.deck_id] = [];
    byDeck[c.deck_id].push(c);
  });

  let html = `
    <div class="panel">
      <div class="panel-title">
        <button class="btn btn-sm" data-action="errorbook-back" type="button">← 返回</button>
        <span class="title-icon" style="margin-left:10px">❌</span>
        <span style="font-weight:800">错题本</span>
        <span style="font-size:11.5px;color:var(--text-muted);margin-left:8px">${cards.length} 张待复习</span>
        ${cards.length ? `
          <button class="btn btn-sm btn-ghost" data-action="errorbook-clear-all" type="button" title="清空全部错题标记">🧹 清空</button>
        ` : ''}
        ${cards.length ? `
          <button class="btn btn-sm btn-primary" data-action="errorbook-start" type="button" style="margin-left:auto">
            ▶ 开始复习错题（${cards.length}）
          </button>
        ` : ''}
      </div>
    </div>
  `;

  if (!cards.length) {
    html += `
      <div class="panel">
        <div class="review-empty">
          <div class="review-empty-icon">✨</div>
          <div class="review-empty-title">错题本是空的</div>
          <div class="review-empty-desc">
            默写或随机测试答错的卡片会自动出现在这里<br>
            答对后错题计数会自动减少
          </div>
        </div>
      </div>`;
    return html;
  }

  /* 每个卡片组一个区块 */
  Object.keys(byDeck).forEach(deckId => {
    const deck = DB.decks.find(d => d.id === deckId);
    const deckCards = byDeck[deckId];
    html += `
      <div class="panel">
        <div class="panel-title" style="margin-bottom:8px">
          <span class="title-icon" style="color:${deck ? (deck.color || 'var(--accent)') : 'var(--accent)'}">📚</span>
          <span style="font-weight:800">${deck ? esc(deck.name) : '(卡片组已删除)'}</span>
          <span style="font-size:11.5px;color:var(--text-muted);margin-left:8px">${deckCards.length} 张</span>
          <button class="btn btn-sm btn-ghost" data-action="errorbook-clear-deck" data-deck-id="${deckId}" type="button" style="margin-left:auto">清空本组</button>
        </div>
        <div class="errorbook-list">
          ${deckCards.map((c, i) => renderErrorRow(c, i)).join('')}
        </div>
      </div>
    `;
  });

  return html;
}

function renderErrorRow(c, i) {
  const wrongCount = c.wrongCount || 0;
  const prog = Math.round((c.stage || 0) / MAX_STAGE * 100);
  return `
    <div class="errorbook-row" data-id="${c.id}" style="--i:${i}">
      <div class="errorbook-badge">${wrongCount}</div>
      <div class="errorbook-main">
        <div class="errorbook-front">${esc(c.front)}</div>
        <div class="errorbook-back">${esc(c.back)}</div>
        <div class="errorbook-meta">
          <div class="ebm-progress">
            <div class="ebm-bar"><div class="ebm-fill" style="width:${prog}%"></div></div>
            <span>阶段 ${c.stage || 0} / ${MAX_STAGE}</span>
          </div>
          ${c.reviewCount ? `<span class="ebm-rc">复习 ${c.reviewCount} 次</span>` : ''}
        </div>
      </div>
      <div class="errorbook-actions">
        <button class="btn btn-xs btn-ghost" data-action="card-curve" data-id="${c.id}" type="button" title="背诵曲线">📈</button>
        <button class="btn btn-xs btn-ghost" data-action="errorbook-mark-ok" data-id="${c.id}" type="button" title="标记为已掌握（清空错题计数）">✓</button>
        <button class="btn btn-xs btn-ghost" data-action="card-edit" data-id="${c.id}" type="button" title="编辑">✎</button>
      </div>
    </div>`;
}

/* ============ Actions ============ */
export const actions = {
  'errorbook-open': () => {
    State.reviewView = 'errors';
    State.reviewDeckId = null;
    rerender();
  },

  'errorbook-back': () => {
    State.reviewView = 'main';
    rerender();
  },

  'errorbook-start': () => {
    const cards = DB.cards.filter(c => c.user_id === State.user.id && (c.wrongCount || 0) > 0);
    if (!cards.length) { toast('错题本是空的', 'info'); return; }
    import('./reviewer.js').then(m => {
      m.startReview('__errors__');
    });
  },

  'errorbook-mark-ok': (el) => {
    const c = DB.cards.find(x => x.id === el.dataset.id);
    if (!c) return;
    c.wrongCount = 0;
    save('cards');
    emit('db:changed');
    toast('已从错题本移除', 'success');
    rerender();
  },

  'errorbook-clear-deck': (el) => {
    const deckId = el.dataset.deckId;
    const deck = DB.decks.find(d => d.id === deckId);
    const count = DB.cards.filter(c => c.user_id === State.user.id && c.deck_id === deckId && (c.wrongCount || 0) > 0).length;
    if (!count) return;
    if (!confirm(`清空「${deck ? deck.name : '该卡片组'}」的 ${count} 张错题标记？\n（仅清空错题计数，卡片本身和复习进度保留）`)) return;

    DB.cards.forEach(c => {
      if (c.user_id === State.user.id && c.deck_id === deckId) c.wrongCount = 0;
    });
    save('cards');
    emit('db:changed');
    toast(`已清空 ${count} 张错题标记`, 'success');
    rerender();
  },

  'errorbook-clear-all': () => {
    const count = DB.cards.filter(c => c.user_id === State.user.id && (c.wrongCount || 0) > 0).length;
    if (!count) return;
    if (!confirm(`清空全部 ${count} 张错题标记？\n（仅清空错题计数，卡片本身和复习进度保留）`)) return;

    DB.cards.forEach(c => {
      if (c.user_id === State.user.id) c.wrongCount = 0;
    });
    save('cards');
    emit('db:changed');
    toast(`已清空 ${count} 张错题标记`, 'success');
    rerender();
  }
};
// END OF FILE