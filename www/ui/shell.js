import { getModules } from '../core/registry.js';
import { DB, State, save, S } from '../core/db.js';
import { $ } from '../core/utils.js';
import * as Theme from '../core/theme.js';
import { APP_VERSION } from '../core/version.js';

export function render() {
  Theme.apply();

  const app = $('#app');
  const modules = getModules();

  app.innerHTML = `
    <div class="app-container">
      <div class="top-nav">
        <div class="nav-left">
          <span class="nav-title" data-action="go-home" role="button">🎯 生涯助手 <span class="app-version">v${APP_VERSION}</span></span>
        </div>
        <div class="nav-right">
          <span class="nav-user">${State.user ? State.user.username : ''}</span>
          <span id="weatherTopHost"></span>
          <button class="theme-toggle" data-action="theme-cycle" type="button">${Theme.icon()}</button>
          <button class="btn btn-sm btn-icon" data-action="go-settings" type="button">⚙️</button>
          <button class="btn btn-sm" data-action="logout" type="button">退出</button>
        </div>
      </div>
      <div class="function-bar" id="functionBar">
        ${modules.filter(m => !m.hidden).map(m => `
          <button class="function-tab${State.currentTab === m.id ? ' active' : ''}" data-tab="${m.id}" type="button">
            <span class="tab-icon">${m.icon}</span><span>${m.name}</span>
          </button>
        `).join('')}
      </div>
      <div class="main-content" id="mainContent"></div>
    </div>
  `;

  $('#functionBar').addEventListener('click', e => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    switchTab(btn.dataset.tab);
  });

  currentRenderedTab = null;
  switchTab(State.currentTab || modules[0]?.id);
  updateReviewBadge();
}

let currentRenderedTab = null;

export function switchTab(id) {
  if (currentRenderedTab === id) return;

  const main = $('#mainContent');
  if (!main) return;

  const mod = getModules().find(m => m.id === id);
  if (!mod) return;

  const di = document.getElementById('diaryInput');
  if (di && State.user) {
    State.diaryDraft = di.value;
    S.set('diaryDraft_' + State.user.id, State.diaryDraft);
  }

  const oldScroll = main.scrollTop;
  const isSameTab = (State.currentTab === id);

  State.currentTab = id;
  S.set('current_tab', id);
  currentRenderedTab = id;

  document.querySelectorAll('.function-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === id);
  });

  try {
    main.innerHTML = mod.render();
    if (isSameTab && oldScroll > 0) main.scrollTop = oldScroll;
    else main.scrollTop = 0;
    if (mod.mounted) mod.mounted();
  } catch (err) {
    console.error('[switchTab] 渲染失败:', id, err);
    currentRenderedTab = null;
  }
}

let rerendering = false;
export function rerender(options = {}) {
  if (rerendering) return;
  rerendering = true;
  try {
    currentRenderedTab = null;
    const main = $('#mainContent');
    const scroll = main ? main.scrollTop : 0;
    switchTab(State.currentTab);
    if (main && !options.resetScroll) main.scrollTop = scroll;
  } finally {
    setTimeout(() => { rerendering = false; }, 0);
  }
}

export function forceReload() {
  const main = $('#mainContent');
  if (!main) return;
  const scroll = main.scrollTop;
  currentRenderedTab = null;
  const id = State.currentTab;
  const mod = getModules().find(m => m.id === id);
  if (mod) {
    try {
      main.innerHTML = mod.render();
      if (mod.mounted) mod.mounted();
      main.scrollTop = scroll;
    } catch (err) {
      console.error('[forceReload] 渲染失败:', id, err);
      currentRenderedTab = null;
    }
  }
}

/* ============================================================
 * ⭐ 复习室角标：显示待复习卡片数
 * ============================================================ */

export function updateReviewBadge() {
  const tab = document.querySelector('.function-tab[data-tab="review"]');
  if (!tab) return;

  const old = tab.querySelector('.tab-badge');
  if (old) old.remove();

  if (!State.user) return;

  const now = Date.now();
  const dueCount = DB.cards.filter(c =>
    c.user_id === State.user.id &&
    !c.mastered &&
    (c.nextReview || 0) <= now
  ).length;

  if (dueCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'tab-badge';
    badge.textContent = dueCount > 99 ? '99+' : String(dueCount);
    badge.title = `${dueCount} 张卡片待复习`;
    tab.appendChild(badge);
  }
}

export function themeIcon() {
  return Theme.icon();
}