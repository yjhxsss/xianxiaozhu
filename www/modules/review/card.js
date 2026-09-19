import { DB, State, save, snapshotDelete, undo } from '../../core/db.js';
import { esc, uid, today } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { show as showModal, hide as hideModal } from '../../ui/modal.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';
import { humanNextReview, cardProgress, MAX_STAGE, STAGES } from './algorithm.js';
import { showCurveModal } from './curve.js';

export function renderDeckDetail() {
  const deckId = State.reviewDeckId;
  if (!deckId) return '';
  const deck = DB.decks.find(d => d.id === deckId && d.user_id === State.user.id);
  if (!deck) return '';

  const allCards = DB.cards.filter(c => c.user_id === State.user.id && c.deck_id === deckId);
  const q = (State.cardSearchQuery || '').toLowerCase().trim();
  const cards = q ? allCards.filter(c =>
    (c.front || '').toLowerCase().includes(q) || (c.back || '').toLowerCase().includes(q)
  ) : allCards;

  const now = Date.now();
  const due = allCards.filter(c => !c.mastered && (c.nextReview || 0) <= now).length;
  const mastered = allCards.filter(c => c.mastered).length;
  const errCount = allCards.filter(c => (c.wrongCount || 0) > 0).length;

  const dictableCount = allCards.filter(c => {
    const front = (c.front || '').trim();
    return /[a-zA-Z]/.test(front) && !/[\u4e00-\u9fa5]/.test(front) && /[\u4e00-\u9fa5]/.test(c.back || '');
  }).length;

  let html = `
    <div class="panel">
      <div class="panel-title">
        <button class="btn btn-sm" data-action="deck-back" type="button">← 返回</button>
        <span class="title-icon" style="margin-left:10px;color:${deck.color || 'var(--accent)'}">📚</span>
        <span style="font-weight:800">${esc(deck.name)}</span>
        <span style="font-size:11.5px;color:var(--text-muted);margin-left:8px">${allCards.length} 张 · ${mastered} 已掌握</span>
        <button class="btn btn-sm btn-ghost" data-action="card-import" data-deck-id="${deckId}" type="button" title="批量导入">📥 导入</button>
        <button class="btn btn-sm btn-ghost" data-action="ai-gen-open" data-deck-id="${deckId}" type="button" title="AI 生成素材">🤖 AI 生成</button>
        <button class="btn btn-sm btn-primary" data-action="card-new" data-deck-id="${deckId}" type="button" style="margin-left:auto">+ 新建卡片</button>
      </div>

      ${allCards.length ? `
        <div class="deck-action-bar">
          ${due > 0 ? `
            <button class="btn btn-primary" data-action="review-start" data-id="${deckId}" type="button">
              ▶ 复习（${due} 张待复习）
            </button>
          ` : `
            <button class="btn btn-ghost" type="button" disabled>
              ✓ 今日复习已完成
            </button>
          `}
          ${dictableCount > 0 ? `
            <button class="btn" data-action="dictation-start" data-id="${deckId}" type="button" title="默写英文单词">
              ✍️ 默写（${dictableCount}）
            </button>
          ` : ''}
          <button class="btn" data-action="quiz-start" data-id="${deckId}" data-count="10" type="button" title="随机抽 10 张做选择题">
            🎲 随机测试
          </button>
          ${errCount > 0 ? `
            <button class="btn errorbook-btn" data-action="errorbook-open" type="button" title="本组错题">
              ❌ 错题（${errCount}）
            </button>
          ` : ''}
        </div>

        <div class="card-search-bar">
          <span class="csb-icon">🔍</span>
          <input type="text" class="csb-input" id="cardSearchInput"
                 placeholder="搜索卡片（正面 / 背面）"
                 value="${esc(State.cardSearchQuery || '')}"
                 autocomplete="off">
          ${q ? `
            <button class="csb-clear" data-action="card-search-clear" type="button" title="清除">✕</button>
          ` : ''}
          ${q ? `<span class="csb-count">${cards.length} / ${allCards.length}</span>` : ''}
        </div>
      ` : ''}

      ${allCards.length ? (cards.length ? `
        <div class="card-list">
          ${cards.sort((a, b) => {
            const aDue = !a.mastered && (a.nextReview || 0) <= now ? 0 : (a.mastered ? 2 : 1);
            const bDue = !b.mastered && (b.nextReview || 0) <= now ? 0 : (b.mastered ? 2 : 1);
            if (aDue !== bDue) return aDue - bDue;
            return (b.stage || 0) - (a.stage || 0);
          }).map((c, i) => renderCardRow(c, i)).join('')}
        </div>
      ` : `
        <div class="card-search-empty">
          没有匹配「${esc(q)}」的卡片
        </div>
      `) : `
        <div class="done-empty" style="padding:30px">
          还没有卡片<br>
          <div style="display:flex;gap:10px;justify-content:center;margin-top:14px;flex-wrap:wrap">
            <button class="btn btn-sm btn-primary" data-action="card-new" data-deck-id="${deckId}" type="button">+ 手动添加</button>
            <button class="btn btn-sm" data-action="ai-gen-open" data-deck-id="${deckId}" type="button">🤖 AI 生成</button>
            <button class="btn btn-sm" data-action="card-import" data-deck-id="${deckId}" type="button">📥 批量导入</button>
          </div>
        </div>
      `}
    </div>`;

  return html;
}

function renderCardRow(c, i) {
  const now = Date.now();
  const due = !c.mastered && (c.nextReview || 0) <= now;
  const prog = Math.round(cardProgress(c) * 100);
  const nextText = humanNextReview(c);
  const wrongCount = c.wrongCount || 0;

  let statusCls = 'learning';
  let statusText = nextText;
  if (c.mastered) { statusCls = 'mastered'; }
  else if (due) { statusCls = 'due'; statusText = '待复习'; }

  return `
    <div class="card-row ${statusCls}" data-id="${c.id}" style="--i:${i}">
      <div class="card-row-left">
        <div class="card-row-front">${esc(c.front)}</div>
        <div class="card-row-back">${esc(c.back)}</div>
      </div>
      <div class="card-row-mid">
        <div class="card-row-progress">
          <div class="crp-bar"><div class="crp-fill" style="width:${prog}%"></div></div>
          <div class="crp-text">${c.stage || 0} / ${MAX_STAGE}</div>
        </div>
        <div class="card-row-status ${statusCls}">${esc(statusText)}</div>
        ${c.reviewCount ? `<div class="card-row-rc">复习 ${c.reviewCount} 次</div>` : ''}
      </div>
      ${wrongCount > 0 ? `<div class="card-row-error" title="错题计数">${wrongCount}</div>` : ''}
      <div class="card-row-actions">
        <button class="btn btn-xs btn-ghost" data-action="card-curve" data-id="${c.id}" type="button" title="查看背诵曲线">📈</button>
        <button class="btn btn-xs btn-ghost" data-action="card-edit" data-id="${c.id}" type="button" title="编辑">✎</button>
        <button class="btn btn-xs btn-ghost" data-action="card-reset" data-id="${c.id}" type="button" title="重置进度">🔄</button>
        <button class="btn btn-xs btn-danger" data-action="card-del" data-id="${c.id}" type="button" title="删除">✕</button>
      </div>
    </div>`;
}

export function showCardModal(edit, deckId) {
  const isEdit = !!edit;
  const c = edit || {};
  const targetDeckId = deckId || c.deck_id;

  showModal('cardEdit', `
    <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">${isEdit ? '✏️ 编辑卡片' : '📇 新建卡片'}</h3>
    <input type="hidden" id="cardId" value="${edit ? esc(c.id) : ''}">
    <input type="hidden" id="cardDeckId" value="${esc(targetDeckId || '')}">
    <div style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">正面 / 问题</label>
      <textarea class="input" id="cardFront" placeholder="如：abandon" style="min-height:60px;font-size:13px;line-height:1.6">${edit ? esc(c.front) : ''}</textarea>
    </div>
    <div style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">背面 / 答案</label>
      <textarea class="input" id="cardBack" placeholder="如：v. 放弃；抛弃" style="min-height:60px;font-size:13px;line-height:1.6">${edit ? esc(c.back) : ''}</textarea>
    </div>
    <div style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">例句 / 补充（可选）</label>
      <input type="text" class="input" id="cardExample" value="${edit ? esc(c.example || '') : ''}" placeholder="可选，显示在答案下方">
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
      <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
      <button class="btn btn-sm btn-primary" data-action="card-save" type="button">${isEdit ? '保存' : '添加'}</button>
    </div>
  `);
}

export function showImportModal(deckId) {
  const deck = DB.decks.find(d => d.id === deckId);
  if (!deck) return;

  showModal('cardImport', `
    <h3 style="font-size:16px;margin-bottom:10px;font-weight:800">📥 批量导入到「${esc(deck.name)}」</h3>
    <div class="hint-box" style="margin-bottom:12px">
      每行一张卡片，用 <code>---</code> 分隔正反面：<br>
      <code>abandon --- v. 放弃；抛弃 --- He abandoned the plan.</code><br>
      <code>benefit --- n. 利益；好处</code><br>
      第三段（例句）可选。空行忽略。
    </div>
    <textarea class="input" id="cardImportText" style="min-height:220px;font-family:var(--mono);font-size:12px;line-height:1.7" placeholder="abandon --- v. 放弃；抛弃 --- He abandoned the plan.
benefit --- n. 利益；好处
crucial --- adj. 至关重要的"></textarea>
    <div style="font-size:11.5px;color:var(--text-muted);margin-top:8px">
      也可以粘贴 CSV 格式（用逗号分隔），会自动识别
    </div>
    <div style="display:flex;gap:10px;justify-content:space-between;margin-top:16px;flex-wrap:wrap">
      <button class="btn btn-sm btn-ghost" data-action="modal-close" type="button">关闭</button>
      <button class="btn btn-sm btn-primary" data-action="card-import-confirm" data-deck-id="${deckId}" type="button">✓ 导入</button>
    </div>
  `, 'lg');
}

export const actions = {
  'deck-back': () => {
    State.reviewDeckId = null;
    State.reviewView = 'main';
    State.cardSearchQuery = '';
    rerender();
  },

  'card-new': (el, e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    const deckId = el.dataset.deckId || State.reviewDeckId;
    if (!deckId) { toast('请先选择卡片组', 'warning'); return; }
    showCardModal(null, deckId);
  },

  'card-edit': (el) => {
    const c = DB.cards.find(x => x.id === el.dataset.id);
    if (c) showCardModal(c);
  },

  'card-curve': (el, e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    const c = DB.cards.find(x => x.id === el.dataset.id);
    if (c) showCurveModal(c);
  },

  /* ⭐ 清除搜索 */
  'card-search-clear': () => {
    State.cardSearchQuery = '';
    rerender();
    setTimeout(() => {
      const inp = document.getElementById('cardSearchInput');
      if (inp) inp.focus();
    }, 30);
  },

  'card-save': () => {
    const id = document.getElementById('cardId').value;
    const deckId = document.getElementById('cardDeckId').value;
    const front = document.getElementById('cardFront').value.trim();
    const back = document.getElementById('cardBack').value.trim();
    const example = document.getElementById('cardExample').value.trim();

    if (!front) { toast('正面不能为空', 'warning'); return; }
    if (!back) { toast('背面不能为空', 'warning'); return; }
    if (!deckId) { toast('未指定卡片组', 'error'); return; }

    if (id) {
      const c = DB.cards.find(x => x.id === id);
      if (!c) return;
      c.front = front;
      c.back = back;
      c.example = example;
    } else {
      DB.cards.push({
        id: uid(),
        user_id: State.user.id,
        deck_id: deckId,
        front, back, example,
        hint: '', tags: [],
        stage: 0, nextReview: 0, lastReview: 0, reviewCount: 0, mastered: false,
        wrongCount: 0,
        createdAt: new Date().toISOString()
      });
    }
    save('cards');
    emit('db:changed');
    hideModal();
    toast(id ? '已保存' : '已添加', 'success');
    rerender();
  },

  'card-del': (el) => {
    const c = DB.cards.find(x => x.id === el.dataset.id);
    if (!c) return;
    if (!confirm(`删除这张卡片？\n${c.front.slice(0, 30)}`)) return;
    const removed = snapshotDelete('cards', c.id);
    if (!removed) return;
    save('cards');
    emit('db:changed');
    rerender();
    toast('已删除', 'success', {
      actions: [{
        label: '撤销',
        onClick: () => {
          if (undo()) {
            emit('db:changed');
            toast('已恢复', 'success');
            rerender();
          }
        }
      }]
    });
  },

  'card-reset': (el) => {
    const c = DB.cards.find(x => x.id === el.dataset.id);
    if (!c) return;
    if (!confirm('重置这张卡片的复习进度？\n下次会从「5 分钟」重新开始')) return;
    c.stage = 0;
    c.nextReview = 0;
    c.lastReview = 0;
    c.reviewCount = 0;
    c.mastered = false;
    c.wrongCount = 0;
    save('cards');
    emit('db:changed');
    toast('已重置进度', 'success');
    rerender();
  },

  'card-import': (el) => {
    const deckId = el.dataset.deckId || State.reviewDeckId;
    if (deckId) showImportModal(deckId);
  },

  'card-import-confirm': (el) => {
    const deckId = el.dataset.deckId;
    const textarea = document.getElementById('cardImportText');
    if (!textarea) return;
    const text = textarea.value.trim();
    if (!text) { toast('请粘贴内容', 'warning'); return; }

    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l);
    const cards = [];
    let failed = 0;

    lines.forEach(line => {
      let parts;
      if (line.includes('---')) parts = line.split('---').map(s => s.trim());
      else if (line.includes('\t')) parts = line.split('\t').map(s => s.trim());
      else if (line.includes(',') && line.split(',').length >= 2) parts = line.split(',').map(s => s.trim());
      else { failed++; return; }
      if (parts.length < 2 || !parts[0] || !parts[1]) { failed++; return; }
      cards.push({
        front: parts[0].slice(0, 200),
        back: parts[1].slice(0, 500),
        example: parts[2] ? parts[2].slice(0, 300) : ''
      });
    });

    if (!cards.length) { toast('没有识别到有效卡片，请检查格式', 'warning'); return; }

    cards.forEach(c => {
      DB.cards.push({
        id: uid(),
        user_id: State.user.id,
        deck_id: deckId,
        front: c.front, back: c.back, example: c.example,
        hint: '', tags: [],
        stage: 0, nextReview: 0, lastReview: 0, reviewCount: 0, mastered: false,
        wrongCount: 0,
        createdAt: new Date().toISOString()
      });
    });

    save('cards');
    emit('db:changed');
    hideModal();
    toast(`✅ 已导入 ${cards.length} 张卡片${failed ? `（${failed} 行格式错误）` : ''}`, 'success');
    rerender();
  }
};

/* ⭐ 全局 input：卡片搜索实时过滤 */
document.addEventListener('input', e => {
  if (e.target && e.target.id === 'cardSearchInput') {
    State.cardSearchQuery = e.target.value;
    clearTimeout(window._cardSearchTimer);
    window._cardSearchTimer = setTimeout(() => {
      /* 只重绘列表部分 */
      const listWrap = document.querySelector('.card-list') || document.querySelector('.card-search-empty');
      if (!listWrap) { rerender(); return; }
      /* 简单方案：整体 rerender 但保留焦点 */
      const val = State.cardSearchQuery;
      rerender();
      const inp = document.getElementById('cardSearchInput');
      if (inp) {
        inp.focus();
        inp.setSelectionRange(val.length, val.length);
      }
    }, 200);
  }
});
// END OF FILE