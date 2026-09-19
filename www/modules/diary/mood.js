import { DB, State, save, snapshotDelete, undo } from '../../core/db.js';
import { esc, today, uid, localTime, MOOD_EMOJIS, MOOD_SCORE, MOOD_TAGS } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { show as showModal, hide as hideModal } from '../../ui/modal.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';

export function getTodayMoods() {
  const uid = State.user?.id;
  if (!uid) return [];
  const t = today();
  return DB.moods
    .filter(m => m.user_id === uid && m.date === t)
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
}

export function renderPanel(moods) {
  const cnt = moods.length;
  return `
    <div class="panel">
      <div class="panel-title">
        <span class="title-icon">😊</span>今日心情
        <span style="margin-left:auto;display:flex;gap:6px;align-items:center">
          ${cnt > 3 ? `<button class="btn btn-xs btn-ghost" data-action="show-all-moods" type="button">全部 ${cnt} 条 →</button>` : ''}
          <button class="btn btn-xs btn-primary" data-action="mood-quick-add" type="button">+</button>
        </span>
      </div>
      <div id="todayMoodList">
        ${moods.length ? moods.slice(0, 3).map(renderMoodItem).join('') : '<div class="done-empty">还没有记录心情 😐</div>'}
      </div>
    </div>`;
}

function renderMoodItem(m) {
  const tags = (m.tags || []).join(' · ');
  const editing = State.editingMoodId === m.id;
  return `
    <div class="mood-entry ${editing ? 'expanded' : ''}" data-action="mood-toggle-edit" data-id="${m.id}">
      <span class="mood-entry-emoji">${esc(m.mood)}</span>
      <div class="mood-entry-info">
        <div class="mood-entry-time">${esc(localTime(m.savedAt))}</div>
        ${tags ? `<div class="mood-entry-tags">${esc(tags)}</div>` : ''}
        ${m.trigger ? `<div class="mood-entry-trigger">"${esc(m.trigger.slice(0,14))}"</div>` : ''}
      </div>
      <span style="font-size:11px;color:var(--accent);font-weight:700">${editing ? '▲' : '✎'}</span>
    </div>
    ${editing ? renderInlineEditor(m) : ''}`;
}

function renderInlineEditor(m) {
  const tags = m.tags || [];
  return `
    <div class="mood-edit-inline" data-mood-editor="${m.id}">
      <div class="me-row">
        <div class="me-label">😊 心情</div>
        <div class="me-emojis">
          ${MOOD_EMOJIS.map(x => `<button class="mood-btn${m.mood === x ? ' selected' : ''}" data-action="mood-inline-set" data-id="${m.id}" data-mood="${x}" type="button">${x}</button>`).join('')}
        </div>
      </div>
      <div class="me-row">
        <div class="me-label">🏷️ 标签</div>
        <div class="me-tags">
          ${MOOD_TAGS.map(t => `<button class="mood-tag${tags.includes(t) ? ' selected' : ''}" data-action="mood-inline-tag" data-id="${m.id}" data-tag="${t}" type="button">${t}</button>`).join('')}
        </div>
      </div>
      <div class="me-row">
        <div class="me-label">💭 因为</div>
        <input type="text" class="me-input" data-mood-inline-trigger="${m.id}" value="${esc(m.trigger || '')}" placeholder="例如：完成了项目...">
      </div>
      <div class="me-actions">
        <button class="btn btn-xs btn-danger" data-action="mood-inline-del" data-id="${m.id}" type="button">🗑️ 删除</button>
        <button class="btn btn-xs" data-action="mood-inline-close" type="button">取消</button>
        <button class="btn btn-xs btn-primary" data-action="mood-inline-save" data-id="${m.id}" type="button">💾 保存</button>
      </div>
    </div>`;
}

function findMood(id) {
  const uid = State.user?.id;
  if (!uid) return null;
  return DB.moods.find(x => x.id === id && x.user_id === uid);
}

export const actions = {
  'mood-quick-add': () => {
    showModal('moodQuick', `
      <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">😊 记录心情</h3>
      <div style="display:flex;gap:12px;justify-content:center;margin-bottom:18px;flex-wrap:wrap">
        ${MOOD_EMOJIS.map(m => `<button class="mood-btn" data-action="mood-quick-set" data-mood="${m}" type="button" style="font-size:32px;padding:14px 20px">${m}</button>`).join('')}
      </div>
      <button class="btn btn-sm" data-action="modal-close" data-modal="moodQuick" type="button" style="width:100%">取消</button>
    `);
  },
  'mood-quick-set': (el) => {
    const mood = el.dataset.mood;
    DB.moods.push({ id: uid(), user_id: State.user.id, date: today(), mood, tags: [], trigger: '', savedAt: new Date().toISOString() });
    save('moods');
    emit('db:changed');
    hideModal();
    toast('心情已记录 ' + mood, 'success');
    rerender();
  },
  'mood-toggle-edit': (el) => {
    State.editingMoodId = State.editingMoodId === el.dataset.id ? null : el.dataset.id;
    rerender();
  },
  'mood-inline-set': (el) => {
    const m = findMood(el.dataset.id);
    if (!m) return;
    m.mood = el.dataset.mood;
    save('moods');
    emit('db:changed');
    const editor = document.querySelector(`[data-mood-editor="${m.id}"]`);
    if (editor) {
      editor.querySelectorAll('.me-emojis .mood-btn').forEach(b => {
        b.classList.toggle('selected', b.dataset.mood === m.mood);
      });
    }
    const emojiEl = document.querySelector(`.mood-entry[data-id="${m.id}"] .mood-entry-emoji`);
    if (emojiEl) emojiEl.textContent = m.mood;
  },
  'mood-inline-tag': (el) => {
    const m = findMood(el.dataset.id);
    if (!m) return;
    const t = el.dataset.tag;
    m.tags = m.tags || [];
    const i = m.tags.indexOf(t);
    if (i >= 0) m.tags.splice(i, 1); else m.tags.push(t);
    save('moods');
    emit('db:changed');
    const editor = document.querySelector(`[data-mood-editor="${m.id}"]`);
    if (editor) {
      editor.querySelectorAll('.me-tags .mood-tag').forEach(b => {
        b.classList.toggle('selected', m.tags.includes(b.dataset.tag));
      });
    }
  },
  'mood-inline-save': (el) => {
    const m = findMood(el.dataset.id);
    if (!m) return;
    const input = document.querySelector(`[data-mood-inline-trigger="${m.id}"]`);
    if (input) m.trigger = input.value;
    save('moods');
    emit('db:changed');
    State.editingMoodId = null;
    toast('已保存', 'success');
    rerender();
  },
  'mood-inline-close': () => {
    State.editingMoodId = null;
    rerender();
  },
  'mood-inline-del': (el) => {
    const m = findMood(el.dataset.id);
    if (!m) return;
    if (!confirm('删除这条心情？')) return;

    const removed = snapshotDelete('moods', el.dataset.id);
    if (!removed) return;

    save('moods');
    emit('db:changed');
    State.editingMoodId = null;
    rerender();

    toast('已删除心情', 'success', {
      actions: [{
        label: '撤销',
        onClick: () => {
          if (undo()) {
            emit('db:changed');
            toast('已恢复心情', 'success');
            rerender();
          }
        }
      }]
    });
  },

  /* ⭐ 新增：查看全部心情 */
  'show-all-moods': () => {
    const uid = State.user?.id;
    if (!uid) return;
    const t = today();
    const items = DB.moods
      .filter(m => m.user_id === uid && m.date === t)
      .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));

    showModal('allMoods', `
      <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">😊 今日全部心情（${items.length}）</h3>
      <div style="max-height:60vh;overflow-y:auto;padding-right:4px">
        ${items.map(renderMoodItem).join('')}
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
        <button class="btn btn-sm" data-action="modal-close" type="button">关闭</button>
      </div>
    `, 'lg');
  }
};
// END OF FILE