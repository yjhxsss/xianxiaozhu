import { DB, State, save, snapshotDelete, undo } from '../../core/db.js';
import { esc, uid, today } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { show as showModal, hide as hideModal } from '../../ui/modal.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';
import { classifyCards } from './algorithm.js';

export function getUserDecks() {
  return DB.decks.filter(d => d.user_id === State.user.id);
}

export function getUserCards() {
  return DB.cards.filter(c => c.user_id === State.user.id);
}

export function getDeckCards(deckId) {
  return DB.cards.filter(c => c.user_id === State.user.id && c.deck_id === deckId);
}

const DECK_COLORS = ['#7c6cf8', '#4ade80', '#fbbf24', '#f87171', '#60a5fa', '#f472b6', '#34d399', '#fb923c'];

export function renderPanel() {
  const decks = getUserDecks();
  const cards = getUserCards();
  const now = Date.now();

  const allDue = cards.filter(c => !c.mastered && (c.nextReview || 0) <= now).length;
  const allMastered = cards.filter(c => c.mastered).length;
  const totalReviews = DB.reviewLogs.filter(l => l.user_id === State.user.id).length;
  const errorCount = cards.filter(c => (c.wrongCount || 0) > 0).length;

  let html = `
    <div class="panel">
      <div class="panel-title">
        <span class="title-icon">📚</span>复习室
        <button class="btn btn-sm btn-ghost" data-action="deck-import-sample" type="button" title="导入示例卡片组">📋 示例</button>
        <button class="btn btn-sm btn-ghost" data-action="stats-open" type="button" title="学习统计">📊 统计</button>
        <div class="ai-title-actions">
          ${errorCount > 0 ? `
            <button class="btn btn-sm btn-ghost errorbook-btn" data-action="errorbook-open" type="button" title="查看错题本">
              ❌ 错题本（${errorCount}）
            </button>
          ` : ''}
          <button class="btn btn-sm btn-ghost" data-action="card-import-open" type="button" title="从文件或文本导入">📥 导入</button>
          <button class="btn btn-sm btn-primary" data-action="ai-gen-open" type="button" title="让 AI 生成一批卡片">🤖 AI 生成素材</button>
        </div>
      </div>

      <div class="review-stats-bar">
        <div class="rsb-item ${allDue > 0 ? 'has-due' : ''}">
          <span class="rsb-num">${allDue}</span>
          <span class="rsb-label">今日待复习</span>
        </div>
        <div class="rsb-item">
          <span class="rsb-num">${cards.length}</span>
          <span class="rsb-label">总卡片</span>
        </div>
        <div class="rsb-item">
          <span class="rsb-num">${allMastered}</span>
          <span class="rsb-label">已掌握</span>
        </div>
        <div class="rsb-item">
          <span class="rsb-num">${totalReviews}</span>
          <span class="rsb-label">累计复习</span>
        </div>
        ${allDue > 0 ? `
          <button class="btn btn-primary" data-action="review-start-all" type="button" style="margin-left:auto">
            ▶ 开始复习全部（${allDue}）
          </button>
        ` : ''}
      </div>
    </div>`;

  if (!decks.length) {
    html += `
      <div class="panel">
        <div class="review-empty">
          <div class="review-empty-icon">📖</div>
          <div class="review-empty-title">还没有卡片组</div>
          <div class="review-empty-desc">
            卡片组可以是「英语四级词汇」「申论素材」「专业课概念」等<br>
            基于艾宾浩斯遗忘曲线，系统会在最合适的时间提醒你复习
          </div>
          <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:14px">
            <button class="btn btn-primary" data-action="ai-gen-open" type="button">🤖 AI 生成素材</button>
            <button class="btn" data-action="card-import-open" type="button">📥 导入已有内容</button>
            <button class="btn btn-ghost" data-action="deck-new" type="button">+ 手动创建</button>
          </div>
        </div>
      </div>`;
    return html;
  }

  html += `<div class="deck-grid">`;
  decks.forEach((d, i) => {
    const dcards = getDeckCards(d.id);
    const { due, learning, mastered } = classifyCards(dcards, now);
    const total = dcards.length;
    const masterPct = total ? Math.round(mastered.length / total * 100) : 0;
    const errCount = dcards.filter(c => (c.wrongCount || 0) > 0).length;
    html += `
      <div class="deck-card" data-action="deck-open" data-id="${d.id}" style="--i:${i};--deck-color:${d.color || DECK_COLORS[0]}">
        <div class="deck-card-head">
          <div class="deck-card-title">${esc(d.name)}</div>
          <div class="deck-card-menu">
            <button class="btn btn-xs btn-ghost" data-action="deck-edit" data-id="${d.id}" type="button" title="编辑">✎</button>
            <button class="btn btn-xs btn-danger" data-action="deck-del" data-id="${d.id}" type="button" title="删除">✕</button>
          </div>
        </div>
        ${d.description ? `<div class="deck-card-desc">${esc(d.description)}</div>` : ''}
        <div class="deck-card-stats">
          <div class="dcs-row"><span class="dcs-dot due"></span><span class="dcs-text">待复习 <b>${due.length}</b></span></div>
          <div class="dcs-row"><span class="dcs-dot learning"></span><span class="dcs-text">学习中 <b>${learning.length}</b></span></div>
          <div class="dcs-row"><span class="dcs-dot mastered"></span><span class="dcs-text">已掌握 <b>${mastered.length}</b></span></div>
          ${errCount > 0 ? `<div class="dcs-row"><span class="dcs-dot error"></span><span class="dcs-text">错题 <b>${errCount}</b></span></div>` : ''}
        </div>
        <div class="deck-card-progress">
          <div class="dcp-bar"><div class="dcp-fill" style="width:${masterPct}%"></div></div>
          <div class="dcp-text">${masterPct}% 掌握 · 共 ${total} 张</div>
        </div>
        ${due.length > 0 ? `
          <button class="btn btn-primary btn-sm deck-card-start" data-action="review-start" data-id="${d.id}" type="button">
            ▶ 复习（${due.length}）
          </button>
        ` : (total > 0 ? `
          <button class="btn btn-ghost btn-sm deck-card-start" data-action="deck-open" data-id="${d.id}" type="button">
            ✓ 今日已完成
          </button>
        ` : `
          <button class="btn btn-sm deck-card-start" data-action="card-new" data-deck-id="${d.id}" type="button">
            + 添加卡片
          </button>
        `)}
      </div>`;
  });
  html += '</div>';

  return html;
}

export function showDeckModal(edit) {
  const isEdit = !!edit;
  const d = edit || {};
  const color = d.color || DECK_COLORS[0];
  const colorBtns = DECK_COLORS.map(c =>
    `<button class="deck-color-btn${color === c ? ' active' : ''}" data-action="deck-color-pick" data-color="${c}" type="button" style="background:${c}"></button>`
  ).join('');

  showModal('deckEdit', `
    <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">${isEdit ? '✏️ 编辑卡片组' : '📚 新建卡片组'}</h3>
    <input type="hidden" id="deckId" value="${edit ? esc(d.id) : ''}">
    <input type="hidden" id="deckColor" value="${color}">
    <div style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">名称</label>
      <input type="text" class="input" id="deckName" value="${edit ? esc(d.name) : ''}" placeholder="如：英语四级词汇">
    </div>
    <div style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">描述（可选）</label>
      <input type="text" class="input" id="deckDesc" value="${edit ? esc(d.description || '') : ''}" placeholder="如：高频词 500 个">
    </div>
    <div style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:8px">颜色</label>
      <div class="deck-color-picker">${colorBtns}</div>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
      <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
      <button class="btn btn-sm btn-primary" data-action="deck-save" type="button">${isEdit ? '保存' : '创建'}</button>
    </div>
  `);
}

export const actions = {
  'deck-new': () => showDeckModal(),

  'deck-edit': (el, e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    const d = DB.decks.find(x => x.id === el.dataset.id);
    if (d) showDeckModal(d);
  },

  'deck-color-pick': (el) => {
    const color = el.dataset.color;
    const hidden = document.getElementById('deckColor');
    if (hidden) hidden.value = color;
    el.parentElement.querySelectorAll('.deck-color-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.color === color);
    });
  },

  'deck-save': () => {
    const idEl = document.getElementById('deckId');
    const id = idEl ? idEl.value : '';
    const name = document.getElementById('deckName').value.trim();
    const desc = document.getElementById('deckDesc').value.trim();
    const color = document.getElementById('deckColor').value || DECK_COLORS[0];
    if (!name) { toast('请输入名称', 'warning'); return; }

    if (id) {
      const d = DB.decks.find(x => x.id === id);
      if (!d) return;
      d.name = name;
      d.description = desc;
      d.color = color;
    } else {
      DB.decks.push({
        id: uid(),
        user_id: State.user.id,
        name, description: desc, color,
        createdAt: new Date().toISOString()
      });
    }
    save('decks');
    emit('db:changed');
    hideModal();
    toast(id ? '已保存' : '已创建', 'success');
    rerender();
  },

  'deck-del': (el, e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    const d = DB.decks.find(x => x.id === el.dataset.id);
    if (!d) return;
    const cardCount = getDeckCards(d.id).length;
    if (!confirm(`删除「${d.name}」及其 ${cardCount} 张卡片？`)) return;

    const removedDeck = snapshotDelete('decks', d.id);
    if (!removedDeck) return;
    const removedCards = DB.cards.filter(c => c.deck_id === d.id);
    const removedLogs = DB.reviewLogs.filter(l => l.deck_id === d.id);
    DB.cards = DB.cards.filter(c => c.deck_id !== d.id);
    DB.reviewLogs = DB.reviewLogs.filter(l => l.deck_id !== d.id);
    save('decks', 'cards', 'reviewLogs');
    emit('db:changed');
    rerender();

    toast('已删除卡片组', 'success', {
      actions: [{
        label: '撤销',
        onClick: () => {
          if (undo()) {
            removedCards.forEach(c => { if (!DB.cards.some(x => x.id === c.id)) DB.cards.push(c); });
            removedLogs.forEach(l => { if (!DB.reviewLogs.some(x => x.id === l.id)) DB.reviewLogs.push(l); });
            save('decks', 'cards', 'reviewLogs');
            emit('db:changed');
            toast('已恢复卡片组', 'success');
            rerender();
          }
        }
      }]
    });
  },

  'deck-open': (el) => {
    State.reviewDeckId = el.dataset.id;
    State.reviewView = 'deck';
    State.cardSearchQuery = '';
    rerender();
  },

  'deck-import-sample': () => {
    if (!confirm('将创建 2 个示例卡片组（英语四级核心词 + 申论金句），确定？')) return;
    const baseTime = Date.now() - 3 * 86400000;

    const deck1 = { id: uid(), user_id: State.user.id, name: '英语四级核心词', description: '高频词汇，配例句', color: '#7c6cf8', createdAt: new Date().toISOString() };
    const deck2 = { id: uid(), user_id: State.user.id, name: '申论金句', description: '论述文常用素材', color: '#fbbf24', createdAt: new Date().toISOString() };
    DB.decks.push(deck1, deck2);

    const words1 = [
      ['abandon', 'v. 放弃；抛弃', 'He abandoned the plan.'],
      ['benefit', 'n. 利益；好处  v. 有益于', 'Regular exercise benefits health.'],
      ['crucial', 'adj. 决定性的；至关重要的', 'This is a crucial moment.'],
      ['decline', 'v. 下降；婉拒  n. 衰退', 'Sales declined last year.'],
      ['efficient', 'adj. 高效的', 'She is an efficient worker.'],
      ['facilitate', 'v. 促进；使便利', 'The app facilitates learning.'],
      ['generate', 'v. 产生；生成', 'This idea generated much interest.'],
      ['highlight', 'v. 强调  n. 亮点', 'He highlighted the key points.']
    ];
    const words2 = [
      ['空谈误国', '实干兴邦', '习近平'],
      ['治国有常', '而利民为本', '《淮南子》'],
      ['大道至简', '实干为要', '常用论述'],
      ['为者常成', '行者常至', '《晏子春秋》'],
      ['苟利于民', '不必法古', '《淮南子》'],
      ['人民至上', '生命至上', '抗疫精神']
    ];

    let cnt = 0;
    words1.forEach(([front, back, ex], i) => {
      const created = baseTime + i * 60000;
      let stage = 0, nextReview = 0, mastered = false;
      if (i < 2) { stage = 7; mastered = true; nextReview = Date.now() + 10 * 86400000; }
      else if (i < 5) { stage = 2 + i; nextReview = Date.now() + (i - 1) * 3600000; }
      else { stage = 0; nextReview = Date.now() - 1000; }
      DB.cards.push({
        id: uid(), user_id: State.user.id, deck_id: deck1.id,
        front, back, example: ex, hint: '', tags: [],
        stage, nextReview, lastReview: stage > 0 ? created : 0, reviewCount: stage, mastered,
        wrongCount: 0,
        createdAt: new Date(created).toISOString()
      });
      cnt++;
    });
    words2.forEach(([front, back, source], i) => {
      const created = baseTime + i * 60000;
      let stage = 0, nextReview = 0, mastered = false;
      if (i < 1) { stage = 7; mastered = true; nextReview = Date.now() + 10 * 86400000; }
      else if (i < 3) { stage = 3; nextReview = Date.now() + 12 * 3600000; }
      else { stage = 0; nextReview = Date.now() - 1000; }
      DB.cards.push({
        id: uid(), user_id: State.user.id, deck_id: deck2.id,
        front, back: source ? `${back}（${source}）` : back,
        example: '', hint: '', tags: [],
        stage, nextReview, lastReview: stage > 0 ? created : 0, reviewCount: stage, mastered,
        wrongCount: 0,
        createdAt: new Date(created).toISOString()
      });
      cnt++;
    });

    save('decks', 'cards');
    emit('db:changed');
    toast(`✅ 已导入 2 个卡片组，共 ${cnt} 张卡片`, 'success');
    rerender();
  }
};
// END OF FILE