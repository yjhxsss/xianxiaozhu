import { State } from '../../core/db.js';
import * as Weather from './weather.js';
import * as AI from './ai.js';
import * as Todo from './todo.js';
import * as Mood from './mood.js';
import * as Metric from './metric.js';
import * as Write from './write.js';

export default {
  id: 'diary',
  name: '主页',
  icon: '🏠',
  order: 10,

  render() {
    const items = Write.getTodayItems();
    const todos = Todo.getTodayTodos();
    const moods = Mood.getTodayMoods();
    const doneCount = Todo.getDoneCount();
    const sel = State.parseSourceId ? Write.getDiaryById(State.parseSourceId) : null;

    return `
      <div class="home-grid">
        <div class="home-row-diary-ai">
          <div class="col-left">
            ${Write.renderWritePanel()}
            ${Write.renderDiaryListPanel(items)}
          </div>
          ${AI.renderPanel(sel)}
        </div>
        <div class="home-row home-row-4">
          <div id="weatherCardContainer">${Weather.renderMiniCard()}</div>
          ${Todo.renderPanel(todos)}
          ${Mood.renderPanel(moods)}
          ${Todo.renderDonePanel(doneCount)}
        </div>
        ${Metric.renderPanel()}
      </div>
    `;
  },

  mounted() {
    // ⭐ 天气只在应用启动时加载一次
    if (!State._weatherLoaded) {
      State._weatherLoaded = true;
      Weather.load();
    } else if (State.weather) {
      // 已有数据，直接补上顶部天气按钮
      const top = document.getElementById('weatherTopHost');
      if (top) top.innerHTML = Weather.renderWeatherTop();
    }

    setTimeout(() => {
      Metric.afterRender();
      Todo.renderDoneList();
    }, 50);
  },

  actions: {
    ...Weather.actions,
    ...AI.actions,
    ...Todo.actions,
    ...Mood.actions,
    ...Metric.actions,
    ...Write.actions
  }
};