import { register, getModules } from './core/registry.js';
import { render as renderShell, switchTab, rerender, forceReload, updateReviewBadge } from './ui/shell.js';
import { hide as hideModal } from './ui/modal.js';
import { toast } from './ui/toast.js';
import { DB, State, S, flush, undo, reloadFromStorage, setLastSeenVersion, migrateUserData, loadUserConfig } from './core/db.js';
import { on } from './core/bus.js';
import { today } from './core/utils.js';
import * as Theme from './core/theme.js';
import { APP_VERSION, BUILD_DATE } from './core/version.js';
import { restoreAIState } from './modules/diary/ai.js';

import * as Auth from './modules/auth/index.js';

import diary      from './modules/diary/index.js';
import calsch     from './modules/calsch/index.js';
import habitgoal  from './modules/habitgoal/index.js';
import health     from './modules/health/index.js';
import timer      from './modules/timer/index.js';
import summary    from './modules/summary/index.js';
import settings   from './modules/settings/index.js';
import onboarding from './modules/onboarding/index.js';
import review     from './modules/review/index.js';

register(diary);
register(calsch);
register(habitgoal);
register(health);
register(timer);
register(summary);
register(settings);
register(onboarding);
register(review);

Theme.init();

const DUE_NOTIFY_COOLDOWN = 4 * 60 * 60 * 1000;
let _lastDueNotifyAt = 0;

function countDueCards() {
  if (!State.user) return 0;
  const now = Date.now();
  return DB.cards.filter(c =>
    c.user_id === State.user.id &&
    !c.mastered &&
    (c.nextReview || 0) <= now
  ).length;
}

function checkReviewDue(force = false) {
  if (!State.user) return;
  const dueCount = countDueCards();
  if (dueCount <= 0) return;

  const now = Date.now();
  if (!force && now - _lastDueNotifyAt < DUE_NOTIFY_COOLDOWN) return;
  _lastDueNotifyAt = now;

  toast(`📚 有 ${dueCount} 张卡片待复习`, 'info', {
    duration: 6000,
    actionDuration: 10000,
    actions: [
      { label: '去复习', onClick: () => { switchTab('review'); } },
      { label: '稍后', onClick: () => {} }
    ]
  });
}

setInterval(() => {
  checkReviewDue(false);
}, 30 * 60 * 1000);

let _badgeTimer = null;
function scheduleUpdateBadge() {
  if (_badgeTimer) return;
  _badgeTimer = setTimeout(() => {
    _badgeTimer = null;
    try { updateReviewBadge(); } catch (e) { console.warn(e); }
  }, 200);
}

on('db:changed', scheduleUpdateBadge);

function checkVersionAndBackup() {
  const lastVer = State.lastSeenVersion;
  if (lastVer && lastVer !== APP_VERSION) {
    setTimeout(() => {
      toast(`🎉 已更新到 v${APP_VERSION}`, 'success', { duration: 4000, actionDuration: 5000, actions: [
        { label: '查看更新', onClick: () => { switchTab('settings'); } }
      ]});
    }, 1200);
  }
  setLastSeenVersion(APP_VERSION);

  const lastBackup = State.lastBackupAt || 0;
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  if (lastBackup && Date.now() - lastBackup > SEVEN_DAYS) {
    const days = Math.floor((Date.now() - lastBackup) / 86400000);
    setTimeout(() => {
      toast(`📦 已经 ${days} 天没备份数据了`, 'warning', {
        duration: 8000, actionDuration: 15000,
        actions: [{ label: '去备份', onClick: () => { switchTab('settings'); } }]
      });
    }, 2500);
  }
}

function triggerAction(action) {
  const fakeEl = document.createElement('div');
  fakeEl.dataset.action = action;
  for (const mod of getModules()) {
    if (mod.actions && mod.actions[action]) {
      try { mod.actions[action](fakeEl, {}); } catch (e) { console.error(e); }
      return true;
    }
  }
  if (Auth.actions[action]) {
    try { Auth.actions[action](fakeEl, {}); } catch (e) { console.error(e); }
    return true;
  }
  return false;
}

function restoreDraft() {
  if (!State.user) return;
  State.diaryDraft = S.get('diaryDraft_' + State.user.id, '') || '';
}

on('auth:login', (user) => {
  State.user = user;
  try {
    migrateUserData(user.id);
    /* ⭐ loadUserConfig 已在 auth 里调用，这里不用重复 */
    restoreAIState(user.id);
    restoreDraft();
    renderShell();
    updateReviewBadge();
    setTimeout(() => checkReviewDue(false), 3000);
    onboarding.maybeStart();
    checkVersionAndBackup();
  } catch (e) { showFatal(e); }
});

try {
  const sid = S.get('current_user_id', null);
  const user = sid ? DB.users.find(x => x.id === sid) : null;
  if (user) {
    State.user = user;
    migrateUserData(user.id);
    /* ⭐ 启动时加载该用户的 AI / 高德配置 */
    loadUserConfig(user.id);
    restoreAIState(user.id);
    restoreDraft();
    renderShell();
    updateReviewBadge();
    setTimeout(() => checkReviewDue(false), 3000);
    onboarding.maybeStart();
    checkVersionAndBackup();
  } else {
    document.getElementById('app').innerHTML = Auth.render();
  }
} catch (err) {
  showFatal(err);
}

function showFatal(err) {
  console.error('[启动失败]', err);
  document.body.innerHTML = `<div style="padding:40px;color:#f87171;font-family:monospace">
    <h2>启动失败</h2>
    <pre style="white-space:pre-wrap;background:#181a28;padding:16px;border-radius:8px;margin-top:16px">${err.message}\n\n${err.stack || ''}</pre>
  </div>`;
}

document.addEventListener('input', e => {
  if (e.target && e.target.id === 'diaryInput' && State.user) {
    State.diaryDraft = e.target.value;
    S.set('diaryDraft_' + State.user.id, State.diaryDraft);
  }
});

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  if (!State.user) {
    if (Auth.actions[action]) {
      e.preventDefault();
      Auth.actions[action](el, e);
    }
    return;
  }

  if (action === 'logout' && Auth.actions.logout) {
    e.preventDefault();
    Auth.actions.logout();
    return;
  }

  if (action === 'modal-close') { e.preventDefault(); hideModal(); return; }
  if (action === 'go-home')     { e.preventDefault(); switchTab('diary'); return; }
  if (action === 'go-settings') { e.preventDefault(); switchTab('settings'); return; }

  if (action === 'theme-cycle') {
    e.preventDefault();
    const newTheme = Theme.cycle();
    toast('主题: ' + { dark: '🌙', light: '☀️', auto: '🌓' }[newTheme], 'success');
    return;
  }

  for (const mod of getModules()) {
    if (mod.actions && mod.actions[action]) {
      e.preventDefault();
      mod.actions[action](el, e);
      return;
    }
  }
  console.warn('[未处理动作]', action);
});

document.addEventListener('keydown', e => {
  if (document.getElementById('onboardingOverlay')) return;
  if (document.getElementById('reviewOverlay')) return;
  if (document.getElementById('dictationOverlay')) return;
  if (document.getElementById('quizOverlay')) return;

  const tag = e.target.tagName;
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    flush();
    toast('已保存到本地', 'success');
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !isInput) {
    e.preventDefault();
    if (undo()) {
      toast('已撤销', 'success');
      rerender();
    } else {
      toast('没有可撤销的操作', 'info');
    }
    return;
  }

  if (isInput) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const k = e.key.toLowerCase();

  if (k === 'escape') {
    const modal = document.querySelector('[id^="modal-"]');
    if (modal) { e.preventDefault(); hideModal(); return; }
    return;
  }

  if (k === 'n') {
    e.preventDefault();
    switchTab('diary');
    setTimeout(() => {
      const el = document.getElementById('diaryInput');
      if (el) el.focus();
    }, 100);
  } else if (k === 't') {
    e.preventDefault();
    triggerAction('todo-add');
  } else if (k === 'm') {
    e.preventDefault();
    triggerAction('mood-quick-add');
  } else if (k === 'g') {
    e.preventDefault();
    switchTab('habitgoal');
  } else if (k === 'c') {
    e.preventDefault();
    switchTab('calsch');
  } else if (k === 's') {
    e.preventDefault();
    switchTab('summary');
  } else if (k === 'r') {
    e.preventDefault();
    switchTab('review');
  } else if (k === ',') {
    e.preventDefault();
    switchTab('settings');
  }
});

try {
  const params = new URLSearchParams(location.search);
  const goto = params.get('goto');
  if (goto && ['diary', 'calsch', 'habitgoal', 'health', 'timer', 'summary', 'settings', 'review'].includes(goto)) {
    setTimeout(() => {
      if (State.user) switchTab(goto);
    }, 100);
  }
} catch (e) {}

let _todayAtBoot = today();
function checkDayChange() {
  const now = today();
  if (now === _todayAtBoot) return;
  _todayAtBoot = now;

  State.doneExpanded = false;
  State.expandedGoalId = null;
  State.editingMoodId = null;
  State.parseSourceId = null;
  State.parsedItems = [];
  State.summaryStart = now;
  State.summaryEnd = now;

  if (State.user) {
    forceReload();
    toast('新的一天，数据已更新', 'info');
    _lastDueNotifyAt = 0;
    setTimeout(() => checkReviewDue(false), 2000);
  }
}
setInterval(checkDayChange, 60 * 1000);

let _storageTimer = null;
window.addEventListener('storage', e => {
  if (!e.key || !e.key.startsWith('xxz_')) return;
  if (e.key === 'xxz_current_user_id') {
    location.reload();
    return;
  }

  clearTimeout(_storageTimer);
  const activeEl = document.activeElement;
  const isEditing = activeEl && (
    activeEl.tagName === 'INPUT' ||
    activeEl.tagName === 'TEXTAREA' ||
    activeEl.isContentEditable
  );
  const delay = isEditing ? 3000 : 300;

  _storageTimer = setTimeout(() => {
    const di = document.getElementById('diaryInput');
    if (di && State.user) {
      State.diaryDraft = di.value;
      S.set('diaryDraft_' + State.user.id, State.diaryDraft);
    }
    reloadFromStorage();
    if (State.user) {
      try { forceReload(); } catch (e) { console.warn('[storage reload]', e); }
    }
  }, delay);
});

window.__app = { APP_VERSION, BUILD_DATE, DB, State };