import { State } from '../../core/db.js';
import * as Habit from './habit.js';
import * as Goal from './goal.js';
import * as Badge from './badge.js';
import { switchTab, forceReload } from '../../ui/shell.js';

export default {
  id: 'habitgoal',
  name: '习惯与目标',
  icon: '🔥',
  order: 30,

  render() {
    const habits = Habit.getHabits();
    const goals = Goal.getGoals();

    return `
      <div class="home-grid">
        <div class="home-row home-row-2">
          ${Habit.renderPanel(habits)}
          ${Goal.renderPanel(goals)}
        </div>
        <div class="home-row home-row-2">
          ${Habit.renderHeatmap()}
          ${Badge.renderPanel()}
        </div>
      </div>
    `;
  },

  mounted() {
    Badge.check();

    // ⭐ 关键修复：用 forceReload 而不是 switchTab
    // 因为用户已经在 habitgoal tab 上，switchTab 会因 currentRenderedTab === id 直接返回
    window.__reloadHabitGoal = () => forceReload();
  },

  actions: {
    ...Habit.actions,
    ...Goal.actions,
    ...Badge.actions
  }
};
// END OF FILE