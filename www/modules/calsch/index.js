import { State, save } from '../../core/db.js';
import { esc, today, fmtD, uid } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { show as showModal, hide as hideModal } from '../../ui/modal.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';
import * as Calendar from './calendar.js';
import * as Schedule from './schedule.js';
import * as Importer from './importer.js';

export default {
  id: 'calsch',
  name: '日历与课表',
  icon: '📅',
  order: 20,

  render() {
    return `
      <div class="home-grid">
        <div class="calsch-layout">
          <div class="panel">
            ${Calendar.renderHeader()}
            ${Calendar.renderGrid()}
          </div>
          ${Calendar.renderDetail()}
        </div>
        ${Schedule.render()}
      </div>`;
  },

  actions: {
    'cal-view': (el) => { Calendar.calState.view = el.dataset.view; rerender(); },
    'cal-prev': () => { Calendar.move(-1); rerender(); },
    'cal-next': () => { Calendar.move(1); rerender(); },
    'cal-today': () => {
      Calendar.calState.date = new Date();
      Calendar.calState.selected = new Date();
      State.calTodosExpanded = false;
      rerender();
    },
    'cal-show-day': (el) => {
      Calendar.calState.selected = new Date(el.dataset.date + 'T00:00:00');
      State.calTodosExpanded = false;
      rerender();
    },

    /* ⭐ 日历页待办展开 / 收起 */
    'toggle-cal-todos-expand': () => {
      State.calTodosExpanded = !State.calTodosExpanded;
      rerender();
    },

    ...Schedule.actions,
    ...Importer.actions,

    'todo-quick-toggle': (el) => {
      import('../diary/todo.js').then(({ toggleTodo }) => {
        const result = toggleTodo(el.dataset.id);
        if (result.status === 'need-dialog') {
          import('../diary/todo.js').then(({ actions }) => {
            if (actions['todo-toggle']) actions['todo-toggle'](el);
          });
          return;
        }
        rerender();
        if (result.toast) toast(result.toast, result.toastType || 'success', { duration: 3000 });
        if (result.undoneGoal) toast('已取消完成，目标进度同步回退', 'info');
      });
    },

    'todo-quick-add': (el) => {
      const ds = el.dataset.date;
      showModal('todoQuickAdd', `
        <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">添加待办 · ${ds}</h3>
        <div style="margin-bottom:12px">
          <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">标题</label>
          <input type="text" class="input" id="qtTitle">
        </div>
        <div style="margin-bottom:12px">
          <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">时间</label>
          <input type="time" class="input" id="qtTime" value="09:00">
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
          <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
          <button class="btn btn-sm btn-primary" data-action="todo-quick-save" data-date="${ds}" type="button">添加</button>
        </div>
      `);
    },

    'todo-quick-save': (el) => {
      const title = document.getElementById('qtTitle').value.trim();
      const time = document.getElementById('qtTime').value || '09:00';
      if (!title) { toast('请输入标题', 'warning'); return; }
      import('../../core/db.js').then(({ DB, save }) => {
        DB.todos.push({
          id: uid(), user_id: State.user.id, title,
          date: el.dataset.date, time, priority: 'medium', repeat: 'none',
          subtasks: [], completed: false, createdAt: new Date().toISOString()
        });
        save('todos');
        emit('db:changed');
        hideModal();
        toast('已添加', 'success');
        rerender();
      });
    }
  }
};
// END OF FILE