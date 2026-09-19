import { DB, State, save } from '../../core/db.js';
import { fmtD, addDays } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { show as showModal } from '../../ui/modal.js';
import { streak as habitStreak } from './habit.js';

const ACHIEVEMENTS = [
  { id: 'first_diary', name: '初露笔尖', icon: '✏️', desc: '写下第一条随笔', check: u => DB.diaries.some(d => d.user_id === u) },
  { id: 'diary_10', name: '记录达人', icon: '📝', desc: '累计 10 条随笔', check: u => DB.diaries.filter(d => d.user_id === u).length >= 10 },
  { id: 'diary_50', name: '文思泉涌', icon: '📚', desc: '累计 50 条随笔', check: u => DB.diaries.filter(d => d.user_id === u).length >= 50 },
  { id: 'first_focus', name: '专注起步', icon: '🍅', desc: '完成第 1 个番茄钟', check: u => DB.focusSessions.some(f => f.user_id === u) },
  { id: 'focus_10h', name: '专注十时', icon: '⏱️', desc: '累计专注 10 小时', check: u => DB.focusSessions.filter(f => f.user_id === u).reduce((s, f) => s + f.duration_minutes, 0) >= 600 },
  { id: 'focus_100h', name: '专注百时', icon: '🏆', desc: '累计专注 100 小时', check: u => DB.focusSessions.filter(f => f.user_id === u).reduce((s, f) => s + f.duration_minutes, 0) >= 6000 },
  { id: 'streak_7', name: '七日之约', icon: '🔥', desc: '连续打卡 7 天', check: u => {
    const days = new Set(DB.focusSessions.filter(f => f.user_id === u).map(f => f.date));
    let n = 0;
    for (let i = 0; i < 10; i++) {
      const d = fmtD(addDays(new Date(), -i));
      if (days.has(d)) n++;
      else if (i > 0) break;
    }
    return n >= 7;
  }},
  { id: 'habit_7', name: '习惯养成', icon: '🌱', desc: '任意习惯连续 7 天', check: u => {
    const h = DB.habits.find(h => h.user_id === u);
    if (!h) return false;
    return habitStreak(h.id, fmtD(new Date())) >= 7;
  }},
  { id: 'mood_30', name: '情绪捕捉', icon: '😊', desc: '记录 30 次心情', check: u => DB.moods.filter(m => m.user_id === u).length >= 30 },
  { id: 'goal_done', name: '目标达成', icon: '🎯', desc: '完成第 1 个目标', check: u => DB.goals.some(g => g.user_id === u && g.completed) },
  { id: 'course_5', name: '课程满档', icon: '📚', desc: '添加 5 门课程', check: u => DB.courses.filter(c => c.user_id === u).length >= 5 },
  { id: 'weight_track', name: '健康追踪', icon: '⚖️', desc: '记录 7 天体重', check: u => {
    const m = DB.metrics.find(x => x.user_id === u && x.name === '体重');
    if (!m) return false;
    return DB.metricValues.filter(v => v.metric_id === m.id).length >= 7;
  }}
];

let lastCheck = 0;

export function has(id) {
  return DB.badges.some(b => b.user_id === State.user?.id && b.id === id);
}

export function check() {
  const now = Date.now();
  if (now - lastCheck < 3000) return;
  lastCheck = now;
  const u = State.user?.id;
  if (!u) return;
  const newOnes = [];
  ACHIEVEMENTS.forEach(a => {
    const owned = DB.badges.find(b => b.user_id === u && b.id === a.id);
    if (owned) { if (!owned.unlockedAt) owned.unlockedAt = new Date().toISOString(); return; }
    try {
      if (a.check(u)) {
        DB.badges.push({ id: a.id, user_id: u, unlockedAt: new Date().toISOString() });
        newOnes.push(a);
      }
    } catch {}
  });
  if (newOnes.length) {
    save('badges');
    newOnes.forEach((a, i) => setTimeout(() => toast(`🏆 解锁成就：${a.name}`, 'success'), i * 400));
  }
}

export function renderPanel() {
  const unlocked = ACHIEVEMENTS.filter(a => has(a.id)).length;
  const preview = ACHIEVEMENTS.slice(0, 8);

  return `
    <div class="panel">
      <div class="panel-title">
        <span class="title-icon">🏆</span>成就徽章
        <span class="more" data-action="show-badges" role="button">${unlocked} / ${ACHIEVEMENTS.length} →</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(70px,1fr));gap:10px">
        ${preview.map(a => {
          const on = has(a.id);
          return `<div class="badge-card ${on ? 'unlocked' : 'locked'}" style="padding:12px 6px">
            <div class="badge-icon" style="font-size:28px;margin-bottom:4px">${a.icon}</div>
            <div style="font-size:10.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.name}</div>
          </div>`;
        }).join('')}
      </div>
      <div style="text-align:center;margin-top:12px">
        <button class="btn btn-sm btn-ghost" data-action="show-badges" type="button">查看全部徽章 →</button>
      </div>
    </div>`;
}

export const actions = {
  'show-badges': () => {
    const unlocked = ACHIEVEMENTS.filter(a => has(a.id)).length;
    showModal('badges', `
      <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">🏆 成就徽章（${unlocked}/${ACHIEVEMENTS.length}）</h3>
      <div class="badge-grid">
        ${ACHIEVEMENTS.map(a => {
          const on = has(a.id);
          return `<div class="badge-card ${on ? 'unlocked' : 'locked'}">
            <div class="badge-icon">${a.icon}</div>
            <div class="badge-name">${a.name}</div>
            <div class="badge-desc">${a.desc}</div>
          </div>`;
        }).join('')}
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
        <button class="btn btn-sm" data-action="modal-close" data-modal="badges" type="button">关闭</button>
      </div>
    `, 'lg');
  }
};

// 暴露给其他模块调用
export { ACHIEVEMENTS };