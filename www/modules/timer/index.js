import { DB, State } from '../../core/db.js';
import { esc, today, localTime } from '../../core/utils.js';
import { rerender } from '../../ui/shell.js';
import * as Pomo from './pomo.js';
import * as Custom from './custom.js';

function getTodaySessions() {
  const uid = State.user?.id;
  if (!uid) return [];
  const t = today();
  return DB.focusSessions
    .filter(f => f.user_id === uid && f.date === t)
    .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
}

function getAllSessions() {
  const uid = State.user?.id;
  if (!uid) return [];
  return DB.focusSessions
    .filter(f => f.user_id === uid)
    .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
}

function renderRecordPanel(sessions) {
  const totalMin = sessions.reduce((s, f) => s + (f.duration_minutes || 0), 0);
  return `
    <div class="panel">
      <div class="panel-title">
        <span class="title-icon">📊</span>今日专注（${sessions.length} 条 · 共 ${totalMin} 分钟）
      </div>
      ${sessions.length
        ? `<div class="focus-list">
            ${sessions.map(s => `
              <div class="focus-item">
                <span class="focus-icon">${s.mode === 'custom' ? '⏲️' : '🍅'}</span>
                <span class="focus-info">${s.note ? esc(s.note) : (s.mode === 'custom' ? '自定义计时' : '番茄钟')}</span>
                <span class="focus-dur">${s.duration_minutes} 分钟</span>
                <span class="focus-time">${esc(localTime(s.completedAt))}</span>
              </div>
            `).join('')}
          </div>`
        : '<div class="done-empty">今天还没有专注记录 🍅</div>'}
    </div>`;
}

export default {
  id: 'timer',
  name: '计时器',
  icon: '⏱️',
  order: 40,

  render() {
    const todaySessions = getTodaySessions();
    const allSessions = getAllSessions();
    const todayMin = todaySessions.reduce((s, f) => s + (f.duration_minutes || 0), 0);
    const allMin = allSessions.reduce((s, f) => s + (f.duration_minutes || 0), 0);

    return `
      <div class="home-grid">
        <div class="timer-grid">
          ${Pomo.render()}
          ${Custom.render()}
        </div>

        <div class="timer-stats-grid">
          <div class="timer-stat-tile">
            <div class="timer-stat-icon">⏰</div>
            <div class="timer-stat-info">
              <div class="timer-stat-label">今日专注</div>
              <div class="timer-stat-value">${todayMin}<span class="small-unit">分钟</span></div>
            </div>
          </div>
          <div class="timer-stat-tile">
            <div class="timer-stat-icon" style="background:rgba(251,191,36,.15);color:var(--warning)">🍅</div>
            <div class="timer-stat-info">
              <div class="timer-stat-label">今日番茄</div>
              <div class="timer-stat-value">${todaySessions.length}<span class="small-unit">个</span></div>
            </div>
          </div>
          <div class="timer-stat-tile">
            <div class="timer-stat-icon" style="background:rgba(74,222,128,.15);color:var(--success)">📈</div>
            <div class="timer-stat-info">
              <div class="timer-stat-label">累计专注</div>
              <div class="timer-stat-value">${allMin}<span class="small-unit">分钟</span></div>
            </div>
          </div>
          <div class="timer-stat-tile">
            <div class="timer-stat-icon" style="background:rgba(96,165,250,.15);color:var(--info)">🏆</div>
            <div class="timer-stat-info">
              <div class="timer-stat-label">累计番茄</div>
              <div class="timer-stat-value">${allSessions.length}<span class="small-unit">个</span></div>
            </div>
          </div>
        </div>

        ${renderRecordPanel(todaySessions)}
      </div>`;
  },

  mounted() {
    // ← 新增：进入计时器时，如果用户已经变了，就把两个计时器状态重置
    const uid = State.user?.id;
    if (uid) {
      Pomo.resetForUser(uid);
      Custom.resetForUser(uid);
    }
    Pomo.afterMount();
    Custom.afterMount();
  },

  actions: {
    'pomo-start': () => Pomo.start(),
    'pomo-reset': () => {
      if (confirm('重置番茄钟？')) Pomo.reset();
    },
    'custom-start': () => Custom.start(),
    'custom-reset': () => {
      if (confirm('重置计时器？')) Custom.reset();
    },
    'timer-preset': (el) => {
      Custom.setPreset(parseInt(el.dataset.min));
    },
    'focus-tag': (el) => {
      State.focusTag = el.dataset.tag;
      rerender();
    }
  }
};