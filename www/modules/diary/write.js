import { DB, State, save, S, snapshotDelete, undo } from '../../core/db.js';
import { esc, today, uid, localTime } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { show as showModal, hide as hideModal } from '../../ui/modal.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';
import { AIHub } from './ai.js';

function draftKey() {
  return 'diaryDraft_' + (State.user?.id || 'guest');
}

/* ============ ⭐ 智能补全额度控制 ============ */
function localToday() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function quotaKey() {
  return 'smart_complete_usage_' + (State.user?.id || 'guest');
}

function getQuota() {
  const t = localToday();
  const u = S.get(quotaKey(), null);
  if (!u || u.date !== t) return { date: t, count: 0 };
  return u;
}

function getQuotaLimit() {
  const c = State.aiConfig || {};
  const n = parseInt(c.smartCompleteLimit);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

function hasQuota() {
  return getQuota().count < getQuotaLimit();
}

function bumpQuota() {
  const u = getQuota();
  u.count += 1;
  S.set(quotaKey(), u);
}

let _quotaWarned = false;

export function getSmartCompleteUsage() {
  return { used: getQuota().count, limit: getQuotaLimit() };
}

/* ============ 数据查询 ============ */
export function getTodayItems() {
  const uid = State.user?.id;
  if (!uid) return [];
  const t = today();
  return DB.diaries
    .filter(d => d.user_id === uid && d.date === t)
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
}

export function getDiaryById(id) {
  const uid = State.user?.id;
  if (!uid) return null;
  return DB.diaries.find(d => d.id === id && d.user_id === uid);
}

export function renderWritePanel() {
  return `
    <div class="panel">
      <div class="panel-title"><span class="title-icon">✏️</span>记录此刻</div>
      <div class="mood-row" id="moodRowButtons">
        ${State.selectedMood || ''}
      </div>
      <textarea class="input" id="diaryInput" placeholder="记录此刻的想法... (快捷键 N)" style="min-height:100px">${esc(State.diaryDraft)}</textarea>
      <div id="diarySuggestion" class="diary-suggestion hidden"></div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn btn-primary" data-action="diary-save" type="button" style="flex:1;min-width:140px">💾 保存随笔</button>
      </div>
    </div>`;
}

export function renderDiaryListPanel(items) {
  const cnt = items.length;
  const preview = items.slice(0, 20);
  return `
    <div class="panel" id="diaryListPanel">
      <div class="panel-title">
        <span class="title-icon">📜</span>今日随笔
        <span style="margin-left:auto">
          ${cnt > 20 ? `<button class="btn btn-xs btn-ghost" data-action="show-all-diaries" type="button">全部 ${cnt} 条 →</button>` : ''}
        </span>
      </div>
      <div id="todayDiaryList" class="diary-list-scroll">
        ${items.length ? preview.map(renderDiaryItem).join('') : '<div class="done-empty">暂无随笔 ✍️</div>'}
      </div>
    </div>`;
}

function renderDiaryItem(d) {
  const active = State.parseSourceId === d.id;
  return `
    <div class="diary-entry${active ? ' active' : ''}" data-action="diary-select" data-id="${d.id}">
      <div style="display:flex;align-items:center;gap:6px">
        <span class="diary-entry-time">🕐 ${esc(localTime(d.savedAt))}</span>
        ${d.mood ? `<span class="diary-entry-mood">${esc(d.mood)}</span>` : ''}
        <span class="diary-entry-actions">
          <button class="btn btn-xs btn-ghost" data-action="diary-edit" data-id="${d.id}" type="button">✎</button>
          <button class="btn btn-xs btn-danger" data-action="diary-del" data-id="${d.id}" type="button">✕</button>
        </span>
      </div>
      <div class="diary-entry-content">${esc(d.content.slice(0, 60))}${d.content.length > 60 ? '...' : ''}</div>
    </div>`;
}

let _suggestTimer = null;
let _suggestAbort = null;
let _lastSuggestFor = '';

function clearSuggestUI() {
  const el = document.getElementById('diarySuggestion');
  if (el) { el.classList.add('hidden'); el.innerHTML = ''; }
}

function renderSuggestUI(text, original) {
  const el = document.getElementById('diarySuggestion');
  if (!el) return;
  if (!text) { clearSuggestUI(); return; }
  el.classList.remove('hidden');
  el.innerHTML = `
    <span class="ds-label">✨ AI 续写</span>
    <span class="ds-text">${esc(text)}</span>
    <button class="btn btn-xs btn-primary" data-action="diary-accept-suggestion" type="button">采纳 (Tab)</button>
    <button class="btn btn-xs btn-ghost" data-action="diary-dismiss-suggestion" type="button">忽略</button>
  `;
  el.dataset.pendingText = text;
  el.dataset.pendingOriginal = original;
}

function scheduleSmartComplete() {
  if (!State.aiConfig || !State.aiConfig.smartComplete) return;
  if (!AIHub.isEnabled()) return;

  /* ⭐ 额度检查 */
  if (!hasQuota()) {
    if (!_quotaWarned) {
      _quotaWarned = true;
      const limit = getQuotaLimit();
      toast(`今日智能补全额度已用完（${limit} 次），可在设置里调整`, 'warning', { duration: 5000 });
    }
    return;
  }

  clearTimeout(_suggestTimer);
  _suggestTimer = setTimeout(async () => {
    if (!hasQuota()) return;

    const input = document.getElementById('diaryInput');
    if (!input) return;
    const v = input.value.trim();
    if (v.length < 5) { clearSuggestUI(); return; }
    if (v === _lastSuggestFor) return;
    _lastSuggestFor = v;

    if (_suggestAbort) { try { _suggestAbort.abort(); } catch {} }
    _suggestAbort = new AbortController();

    /* ⭐ 先扣额度 */
    bumpQuota();

    const el = document.getElementById('diarySuggestion');
    if (el) {
      el.classList.remove('hidden');
      el.innerHTML = `<span class="ds-label">✨ AI 续写中…</span>`;
    }

    try {
      const partial = v.slice(-200);
      const result = await AIHub.completeText(partial);
      const current = (document.getElementById('diaryInput') || {}).value || '';
      if (current.trim() !== v) return;
      if (!result) { clearSuggestUI(); return; }
      renderSuggestUI(result, v);
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('[smartComplete]', e);
      clearSuggestUI();
    }
  }, 2000);
}

document.addEventListener('input', e => {
  if (!e.target || e.target.id !== 'diaryInput') return;
  scheduleSmartComplete();
});

export const actions = {
  'diary-save': () => {
    const input = document.getElementById('diaryInput');
    if (!input) return;
    const content = input.value.trim();
    if (!content) { toast('内容为空', 'warning'); return; }

    const newDiary = {
      id: uid(),
      user_id: State.user.id,
      date: today(),
      content,
      savedAt: new Date().toISOString()
    };
    DB.diaries.push(newDiary);
    if (State.selectedMood) {
      DB.moods.push({
        id: uid(),
        user_id: State.user.id,
        date: today(),
        mood: State.selectedMood,
        tags: State.selectedMoodTags || [],
        trigger: '',
        savedAt: new Date().toISOString()
      });
      State.selectedMood = null;
      State.selectedMoodTags = [];
    }
    save('diaries', 'moods');
    emit('db:changed');

    input.value = '';
    State.diaryDraft = '';
    S.remove(draftKey());
    State.parseSourceId = newDiary.id;
    _lastSuggestFor = '';
    clearSuggestUI();
    input.focus();
    toast('随笔已保存', 'success');
    rerender();
  },

  'diary-select': (el) => {
    State.parseSourceId = el.dataset.id;
    State.parsedItems = [];
    rerender();
  },

  'diary-edit': (el) => {
    const d = DB.diaries.find(x => x.id === el.dataset.id && x.user_id === State.user.id);
    if (!d) return;
    showModal('diaryEdit', `
      <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">✏️ 编辑随笔</h3>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">🕐 ${esc(d.date)} ${esc(localTime(d.savedAt))}</div>
      <textarea class="input" id="diaryEditContent" style="min-height:180px;line-height:1.7">${esc(d.content)}</textarea>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
        <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
        <button class="btn btn-sm btn-primary" data-action="diary-edit-save" data-id="${d.id}" type="button">💾 保存</button>
      </div>
    `);
  },

  'diary-edit-save': (el) => {
    const d = DB.diaries.find(x => x.id === el.dataset.id && x.user_id === State.user.id);
    if (!d) return;
    const ta = document.getElementById('diaryEditContent');
    const content = ta ? ta.value.trim() : '';
    if (!content) { toast('内容不能为空', 'warning'); return; }
    d.content = content;
    save('diaries');
    emit('db:changed');
    hideModal();
    toast('已保存', 'success');
    rerender();
  },

  'diary-del': (el, e) => {
    e && e.stopPropagation();
    if (!confirm('删除？')) return;
    const id = el.dataset.id;
    const d = DB.diaries.find(x => x.id === id && x.user_id === State.user.id);
    if (!d) return;

    const removed = snapshotDelete('diaries', id);
    if (!removed) return;

    if (State.parseSourceId === id) State.parseSourceId = null;
    save('diaries');
    emit('db:changed');
    rerender();

    toast('已删除随笔', 'success', {
      actions: [{
        label: '撤销',
        onClick: () => {
          if (undo()) {
            emit('db:changed');
            toast('已恢复随笔', 'success');
            rerender();
          }
        }
      }]
    });
  },

  'show-all-diaries': () => {
    const uid = State.user?.id;
    if (!uid) return;
    const t = today();
    const items = DB.diaries
      .filter(d => d.user_id === uid && d.date === t)
      .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));

    showModal('allDiaries', `
      <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">📜 今日全部随笔（${items.length}）</h3>
      <div class="diary-list-scroll" style="max-height:60vh">
        ${items.map(renderDiaryItem).join('')}
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
        <button class="btn btn-sm" data-action="modal-close" type="button">关闭</button>
      </div>
    `, 'lg');
  },

  'insert-tpl': (el) => {
    const input = document.getElementById('diaryInput');
    if (!input) return;
    const tpl = {
      daily: '【每日复盘】\n✅成就：\n1.\n2.\n\n📝不足：\n',
      gratitude: '【感恩日记】\n🙏感恩：\n1.\n2.\n',
      goals: '【明日计划】\n🎯三件事：\n1.\n2.\n'
    };
    input.value = tpl[el.dataset.tpl] || '';
    State.diaryDraft = input.value;
    S.set(draftKey(), State.diaryDraft);
    input.focus();
  },

  'diary-accept-suggestion': () => {
    const el = document.getElementById('diarySuggestion');
    if (!el) return;
    const text = el.dataset.pendingText || '';
    const input = document.getElementById('diaryInput');
    if (!input || !text) return;
    const cur = input.value;
    const sep = cur.endsWith('\n') || cur.endsWith(' ') ? '' : ' ';
    input.value = cur + sep + text;
    State.diaryDraft = input.value;
    S.set(draftKey(), State.diaryDraft);
    _lastSuggestFor = '';
    clearSuggestUI();
    input.focus();
  },

  'diary-dismiss-suggestion': () => {
    clearSuggestUI();
    _lastSuggestFor = '';
  }
};

document.addEventListener('keydown', e => {
  if (e.key === 'Tab' && e.target && e.target.id === 'diaryInput') {
    const el = document.getElementById('diarySuggestion');
    if (el && !el.classList.contains('hidden') && el.dataset.pendingText) {
      e.preventDefault();
      actions['diary-accept-suggestion']();
    }
  }
});
// END OF FILE