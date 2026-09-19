import { State, DB, save } from '../../core/db.js';
import { esc, uid } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { show as showModal, hide as hideModal } from '../../ui/modal.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';

import * as Deck from './deck.js';
import * as Card from './card.js';
import * as Reviewer from './reviewer.js';
import * as AI from './ai.js';
import * as Importer from './importer.js';
import * as Dictation from './dictation.js';
import * as Quiz from './quiz.js';
import * as ErrorBook from './errorbook.js';
import * as Stats from './stats.js';

export default {
  id: 'review',
  name: '复习室',
  icon: '📚',
  order: 45,

  render() {
    /* ⭐ 统计页 */
    if (State.reviewView === 'stats') {
      return Stats.renderStats();
    }
    /* 错题本 */
    if (State.reviewView === 'errors' && !State.reviewDeckId) {
      return Stats ? ErrorBook.renderErrorBook() : '';
    }
    /* 卡片组详情 */
    if (State.reviewDeckId) {
      return Card.renderDeckDetail();
    }
    /* 主面板 */
    return Deck.renderPanel();
  },

  mounted() {
    /* ⭐ 统计页渲染后画图 */
    if (State.reviewView === 'stats') {
      Stats.afterMount();
    }
  },

  actions: {
    ...Deck.actions,
    ...Card.actions,
    ...Reviewer.actions,
    ...Importer.actions,
    ...Dictation.actions,
    ...Quiz.actions,
    ...ErrorBook.actions,
    ...Stats.actions,

    'ai-gen-open': (el) => {
      const deckId = el.dataset.deckId || State.reviewDeckId || '';
      AI.showAIGenerateModal({ deckId });
    },

    'ai-gen-quick': (el) => {
      const inp = document.getElementById('aiGenCount');
      if (inp) { inp.value = el.dataset.count; inp.focus(); inp.select(); }
    },

    'ai-gen-run': async () => {
      const deckSel = document.getElementById('aiGenDeck');
      const newDeckNameEl = document.getElementById('aiGenNewDeckName');
      const scopeEl = document.getElementById('aiGenScope');
      const countEl = document.getElementById('aiGenCount');
      if (!deckSel || !countEl) return;

      let deckId = deckSel.value;
      let deckName = '';
      let isNewDeck = false;

      if (deckId === '__new__') {
        deckName = (newDeckNameEl ? newDeckNameEl.value.trim() : '');
        if (!deckName) { toast('请输入新卡片组名称', 'warning'); return; }
        isNewDeck = true;
      } else {
        const d = DB.decks.find(x => x.id === deckId);
        if (!d) { toast('卡片组不存在', 'error'); return; }
        deckName = d.name;
      }

      const scope = scopeEl ? scopeEl.value.trim() : '';
      const count = Math.max(5, Math.min(60, parseInt(countEl.value) || 20));

      let existingFronts = [];
      if (!isNewDeck) {
        existingFronts = DB.cards
          .filter(c => c.deck_id === deckId && c.user_id === State.user.id)
          .slice(0, 30)
          .map(c => c.front);
      }

      showModal('aiGenerateCards', `
        <h3 style="font-size:16px;margin-bottom:12px;font-weight:800">🤖 AI 生成中…</h3>
        <div class="ai-loading" style="padding:30px;text-align:center">
          <div style="font-size:32px;margin-bottom:8px">🤖</div>
          <div style="font-size:13px;font-weight:600">正在生成「${esc(deckName)}」的 ${count} 张卡片</div>
          <div style="font-size:11.5px;margin-top:6px;color:var(--text-muted)">通常 5-20 秒</div>
        </div>
      `);

      try {
        const cards = await AI.aiGenerateCards({ deckName, scope, count, existingFronts });
        if (!cards.length) throw new Error('AI 未返回任何卡片');
        State._aiGeneratedCards = { deckId, deckName, isNewDeck, cards };
        AI.renderGeneratedCards();
      } catch (e) {
        console.error('[ai-gen-run]', e);
        toast('生成失败：' + e.message, 'error');
        AI.showAIGenerateModal({ deckId: isNewDeck ? '' : deckId });
      }
    },

    'ai-gen-toggle': (el) => {
      const cached = State._aiGeneratedCards;
      if (!cached) return;
      const idx = parseInt(el.dataset.idx);
      const c = cached.cards[idx];
      if (!c) return;
      c.selected = !c.selected;
      el.textContent = c.selected ? '☑' : '☐';
      const itemEl = el.closest('.ai-gen-item');
      if (itemEl) itemEl.classList.toggle('selected', c.selected);
      const btn = document.querySelector('[data-action="ai-gen-accept-all"]');
      if (btn) {
        const selCount = cached.cards.filter(x => x.selected).length;
        btn.textContent = `✓ 全部采纳（${selCount}）`;
      }
    },

    'ai-gen-regen': () => {
      const cached = State._aiGeneratedCards;
      if (!cached) return;
      AI.showAIGenerateModal({ deckId: cached.isNewDeck ? '' : cached.deckId });
    },

    'ai-gen-accept-all': () => {
      const cached = State._aiGeneratedCards;
      if (!cached) return;
      const selected = cached.cards.filter(c => c.selected);
      if (!selected.length) { toast('请至少选择一张', 'warning'); return; }

      let deckId = cached.deckId;
      if (cached.isNewDeck) {
        const newDeck = {
          id: uid(),
          user_id: State.user.id,
          name: cached.deckName,
          description: '',
          color: '#7c6cf8',
          createdAt: new Date().toISOString()
        };
        DB.decks.push(newDeck);
        deckId = newDeck.id;
      }

      selected.forEach(c => {
        DB.cards.push({
          id: uid(),
          user_id: State.user.id,
          deck_id: deckId,
          front: c.front, back: c.back, example: c.example || '',
          hint: '', tags: [],
          stage: 0, nextReview: 0, lastReview: 0, reviewCount: 0, mastered: false,
          wrongCount: 0,
          createdAt: new Date().toISOString()
        });
      });

      save('decks', 'cards');
      emit('db:changed');
      hideModal();
      State._aiGeneratedCards = null;
      toast(`✅ 已添加到「${cached.deckName}」，共 ${selected.length} 张`, 'success');
      rerender();
    }
  }
};

document.addEventListener('input', e => {
  const t = e.target;
  if (!t || !t.classList) return;
  if (!t.classList.contains('ai-gen-input')) return;
  const cached = State._aiGeneratedCards;
  if (!cached) return;
  const idx = parseInt(t.dataset.idx);
  const field = t.dataset.field;
  const c = cached.cards[idx];
  if (c && field) c[field] = t.value;
});
// END OF FILE