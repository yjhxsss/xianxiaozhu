import { DB, State, S } from '../../core/db.js';
import { esc, today, addDays, diffDays } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { rerender } from '../../ui/shell.js';
import { show as showModal, hide as hideModal } from '../../ui/modal.js';
import * as Charts from './charts.js';
import { AIHub } from '../diary/ai.js';

const RANGES = [
  { key: 'day', label: '今天' },
  { key: 'week', label: '近 7 天' },
  { key: 'month', label: '近 30 天' },
  { key: 'custom', label: '自定义' }
];

function getRange() {
  const t = today();
  const r = State.summaryRange || 'day';
  if (r === 'day') return { start: t, end: t };
  if (r === 'week') return { start: fmt(addDays(new Date(), -6)), end: t };
  if (r === 'month') return { start: fmt(addDays(new Date(), -29)), end: t };
  if (r === 'custom') return { start: State.summaryStart || t, end: State.summaryEnd || t };
  return { start: t, end: t };
}

function fmt(d) {
  const x = new Date(d);
  const p = n => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

function collect() {
  const uid = State.user?.id;
  const { start, end } = getRange();
  if (!uid) {
    return {
      start, end, daysCount: 1,
      diaries: [], diaryWords: 0,
      todos: [], todoDone: 0, todoTotal: 0,
      moods: [], moodList: [], moodTotal: 0,
      sessions: [], focusMin: 0, focusCount: 0,
      habitLogs: [], habitCount: 0,
      metricRows: [],
      /* ⭐ 健康字段 */
      health: {
        sleepHours: 0, sleepDays: 0, sleepAvg: 0,
        exerciseMin: 0, exerciseCount: 0,
        waterMl: 0, waterAvg: 0,
        calories: 0, caloriesAvg: 0,
        protein: 0, carb: 0, fat: 0,
        dietCount: 0
      }
    };
  }

  const inRange = x => x.date >= start && x.date <= end;

  const diaries = DB.diaries.filter(d => d.user_id === uid && inRange(d));
  const todos = DB.todos.filter(x => x.user_id === uid && inRange(x));
  const moods = DB.moods.filter(m => m.user_id === uid && inRange(m));
  const sessions = DB.focusSessions.filter(f => f.user_id === uid && inRange(f));
  const habitLogs = DB.habitLogs.filter(l => l.user_id === uid && inRange(l));
  const healthRecs = (DB.healthRecords || []).filter(r => r.user_id === uid && inRange(r));

  const metricIds = new Set(DB.metrics.filter(m => m.user_id === uid).map(m => m.id));
  const metricValues = DB.metricValues.filter(v => metricIds.has(v.metric_id) && inRange(v));

  const moodCount = {};
  moods.forEach(m => { moodCount[m.mood] = (moodCount[m.mood] || 0) + 1; });
  const moodList = Object.keys(moodCount).map(k => ({ emoji: k, count: moodCount[k] })).sort((a, b) => b.count - a.count);

  const metricRows = DB.metrics.filter(m => m.user_id === uid).map(m => {
    const vals = metricValues.filter(v => v.metric_id === m.id)
      .sort((a, b) => new Date(b.savedAt || b.date) - new Date(a.savedAt || a.date));
    if (!vals.length) return null;
    return { name: m.name, value: vals[0].value, unit: m.unit };
  }).filter(Boolean);

  const todoDone = todos.filter(x => x.completed).length;
  const focusMin = sessions.reduce((s, f) => s + (f.duration_minutes || 0), 0);
  const diaryWords = diaries.reduce((s, d) => s + (d.content || '').replace(/\s/g, '').length, 0);
  const daysCount = diffDays(end, start) + 1;

  /* ⭐ 健康汇总 */
  const sleepRecs = healthRecs.filter(r => r.type === 'sleep');
  const exRecs = healthRecs.filter(r => r.type === 'exercise');
  const waterRecs = healthRecs.filter(r => r.type === 'water');
  const dietRecs = healthRecs.filter(r => r.type === 'diet');

  const sleepHours = +sleepRecs.reduce((s, r) => s + (r.value || 0), 0).toFixed(1);
  const sleepDays = new Set(sleepRecs.map(r => r.date)).size;
  const exerciseMin = exRecs.reduce((s, r) => s + (r.value || 0), 0);
  const waterMl = waterRecs.reduce((s, r) => s + (r.value || 0), 0);
  const calories = dietRecs.reduce((s, r) => s + (r.calories || r.value || 0), 0);
  const protein = +dietRecs.reduce((s, r) => s + (parseFloat(r.protein) || 0), 0).toFixed(1);
  const carb = +dietRecs.reduce((s, r) => s + (parseFloat(r.carb) || 0), 0).toFixed(1);
  const fat = +dietRecs.reduce((s, r) => s + (parseFloat(r.fat) || 0), 0).toFixed(1);

  return {
    start, end, daysCount,
    diaries, diaryWords,
    todos, todoDone, todoTotal: todos.length,
    moods, moodList, moodTotal: moods.length,
    sessions, focusMin, focusCount: sessions.length,
    habitLogs, habitCount: habitLogs.length,
    metricRows,
    health: {
      sleepHours,
      sleepDays,
      sleepAvg: sleepDays ? +(sleepHours / sleepDays).toFixed(1) : 0,
      exerciseMin,
      exerciseCount: exRecs.length,
      waterMl,
      waterAvg: daysCount ? Math.round(waterMl / daysCount) : 0,
      calories,
      caloriesAvg: daysCount ? Math.round(calories / daysCount) : 0,
      protein, carb, fat,
      dietCount: dietRecs.length
    }
  };
}

function comparePrev() {
  const uid = State.user?.id;
  const { start, end } = getRange();
  const daysCount = diffDays(end, start) + 1;
  const prevEnd = fmt(addDays(new Date(start + 'T00:00:00'), -1));
  const prevStart = fmt(addDays(new Date(prevEnd + 'T00:00:00'), -(daysCount - 1)));

  const empty = {
    diaryWords: 0, todoDone: 0, focusMin: 0, diaryCount: 0,
    health: { sleepHours: 0, exerciseMin: 0, waterMl: 0, calories: 0 }
  };
  if (!uid) return empty;

  const diaries = DB.diaries.filter(d => d.user_id === uid && d.date >= prevStart && d.date <= prevEnd);
  const todos = DB.todos.filter(x => x.user_id === uid && x.date >= prevStart && x.date <= prevEnd);
  const sessions = DB.focusSessions.filter(f => f.user_id === uid && f.date >= prevStart && f.date <= prevEnd);
  const healthRecs = (DB.healthRecords || []).filter(r => r.user_id === uid && r.date >= prevStart && r.date <= prevEnd);

  return {
    diaryWords: diaries.reduce((s, d) => s + (d.content || '').replace(/\s/g, '').length, 0),
    todoDone: todos.filter(x => x.completed).length,
    focusMin: sessions.reduce((s, f) => s + (f.duration_minutes || 0), 0),
    diaryCount: diaries.length,
    health: {
      sleepHours: +healthRecs.filter(r => r.type === 'sleep').reduce((s, r) => s + (r.value || 0), 0).toFixed(1),
      exerciseMin: healthRecs.filter(r => r.type === 'exercise').reduce((s, r) => s + (r.value || 0), 0),
      waterMl: healthRecs.filter(r => r.type === 'water').reduce((s, r) => s + (r.value || 0), 0),
      calories: healthRecs.filter(r => r.type === 'diet').reduce((s, r) => s + (r.calories || r.value || 0), 0)
    }
  };
}

function diffLabel(cur, prev) {
  if (prev === 0) return cur > 0 ? '↑' : '·';
  const d = cur - prev;
  if (d > 0) return `<span class="cmp-diff up">↑ ${Math.round(d / prev * 100)}%</span>`;
  if (d < 0) return `<span class="cmp-diff down">↓ ${Math.round(-d / prev * 100)}%</span>`;
  return '<span class="cmp-diff">—</span>';
}

function fmtNum(n) {
  const x = parseFloat(n);
  if (!isFinite(x)) return '0';
  if (Number.isInteger(x)) return String(x);
  return x.toFixed(1).replace(/\.0$/, '');
}

export default {
  id: 'summary',
  name: '总结',
  icon: '📋',
  order: 50,

  render() {
    const s = collect();
    const prev = comparePrev();
    const aiOn = AIHub.isEnabled();
    const h = s.health;
    const ph = prev.health;

    const hasHealth = h.sleepHours > 0 || h.exerciseMin > 0 || h.waterMl > 0 || h.calories > 0;

    return `
      <div class="summary-page">
        <div class="summary-range-bar">
          ${RANGES.map(r => `
            <button class="summary-range-btn${State.summaryRange === r.key ? ' active' : ''}"
                    data-action="sum-range" data-range="${r.key}" type="button">${r.label}</button>
          `).join('')}
          <div class="summary-range-dates">
            <input type="date" class="input" id="sumStart" value="${s.start}">
            <span style="color:var(--text-muted);font-size:13px;font-weight:600">至</span>
            <input type="date" class="input" id="sumEnd" value="${s.end}">
            <button class="btn btn-sm btn-primary" data-action="sum-apply" type="button">应用</button>
          </div>
        </div>

        <div class="summary-range-bar" style="justify-content:flex-start">
          <span style="font-size:12.5px;color:var(--text-muted);font-weight:700">🤖 AI 分析</span>
          <button class="btn btn-sm ${aiOn ? 'btn-primary' : ''}" data-action="sum-ai-weekly" type="button" ${aiOn ? '' : 'disabled title="请先在设置里启用 AI"'}>📅 生成周报</button>
          <button class="btn btn-sm ${aiOn ? 'btn-primary' : ''}" data-action="sum-ai-mood" type="button" ${aiOn ? '' : 'disabled title="请先在设置里启用 AI"'}>💭 情绪分析</button>
          <button class="btn btn-sm ${aiOn ? 'btn-primary' : ''}" data-action="sum-ai-health" type="button" ${aiOn ? '' : 'disabled title="请先在设置里启用 AI"'}>💚 健康周报</button>
          ${!aiOn ? '<span style="font-size:11px;color:var(--text-muted)">（AI 未启用，请到设置开启）</span>' : ''}
        </div>

        <div class="summary-body">
          <div class="summary-head">
            <div class="summary-title">📋 总结 · ${esc(s.start)} ~ ${esc(s.end)}</div>
            <div class="summary-days">共 ${s.daysCount} 天</div>
          </div>

          <div class="summary-overview">
            <div class="so-item"><div class="so-icon">📝</div><div><div class="so-num">${s.diaryWords}</div><div class="so-label">字记录</div></div></div>
            <div class="so-item"><div class="so-icon">✅</div><div><div class="so-num">${s.todoDone}/${s.todoTotal}</div><div class="so-label">待办</div></div></div>
            <div class="so-item"><div class="so-icon">⏱️</div><div><div class="so-num">${s.focusMin}</div><div class="so-label">分钟专注</div></div></div>
            <div class="so-item"><div class="so-icon">🔥</div><div><div class="so-num">${s.habitCount}</div><div class="so-label">习惯打卡</div></div></div>
          </div>

          ${hasHealth ? `
          <div class="summary-section">
            <div class="summary-section-title">💚 健康数据</div>

            <div class="summary-health-grid">
              <div class="summary-health-cell sleep">
                <div class="shc-icon">😴</div>
                <div class="shc-body">
                  <div class="shc-value">${fmtNum(h.sleepHours)}<span class="shc-unit">h</span></div>
                  <div class="shc-label">总睡眠</div>
                  <div class="shc-sub">${h.sleepDays ? `日均 ${h.sleepAvg}h · ${h.sleepDays} 天` : '未记录'}</div>
                </div>
                ${diffLabel(h.sleepHours, ph.sleepHours)}
              </div>
              <div class="summary-health-cell exercise">
                <div class="shc-icon">🏃</div>
                <div class="shc-body">
                  <div class="shc-value">${h.exerciseMin}<span class="shc-unit">min</span></div>
                  <div class="shc-label">运动时长</div>
                  <div class="shc-sub">${h.exerciseCount} 次</div>
                </div>
                ${diffLabel(h.exerciseMin, ph.exerciseMin)}
              </div>
              <div class="summary-health-cell water">
                <div class="shc-icon">💧</div>
                <div class="shc-body">
                  <div class="shc-value">${fmtNum(h.waterMl)}<span class="shc-unit">ml</span></div>
                  <div class="shc-label">饮水量</div>
                  <div class="shc-sub">日均 ${h.waterAvg}ml</div>
                </div>
                ${diffLabel(h.waterMl, ph.waterMl)}
              </div>
              <div class="summary-health-cell diet">
                <div class="shc-icon">🍱</div>
                <div class="shc-body">
                  <div class="shc-value">${fmtNum(h.calories)}<span class="shc-unit">kcal</span></div>
                  <div class="shc-label">摄入热量</div>
                  <div class="shc-sub">日均 ${h.caloriesAvg} · ${h.dietCount} 条</div>
                </div>
                ${diffLabel(h.calories, ph.calories)}
              </div>
            </div>

            ${(h.protein > 0 || h.carb > 0 || h.fat > 0) ? `
            <div class="summary-macro-grid">
              <div class="summary-macro-cell p">
                <div class="smc-label">🥩 蛋白质</div>
                <div class="smc-value">${fmtNum(h.protein)}<span class="smc-unit">g</span></div>
              </div>
              <div class="summary-macro-cell c">
                <div class="smc-label">🌾 碳水</div>
                <div class="smc-value">${fmtNum(h.carb)}<span class="smc-unit">g</span></div>
              </div>
              <div class="summary-macro-cell f">
                <div class="smc-label">🥑 脂肪</div>
                <div class="smc-value">${fmtNum(h.fat)}<span class="smc-unit">g</span></div>
              </div>
            </div>
            ` : ''}

            <div class="summary-charts" style="margin-top:14px">
              <div class="summary-chart-card">
                <div class="sc-title">😴 睡眠时长（近 7 天）</div>
                <canvas id="chartHealthSleep" class="summary-canvas" style="height:150px"></canvas>
              </div>
              <div class="summary-chart-card">
                <div class="sc-title">💧 饮水（近 7 天）</div>
                <canvas id="chartHealthWater" class="summary-canvas" style="height:150px"></canvas>
              </div>
            </div>
            <div class="summary-charts" style="margin-top:14px">
              <div class="summary-chart-card">
                <div class="sc-title">🔥 卡路里摄入（近 7 天）</div>
                <canvas id="chartHealthCal" class="summary-canvas" style="height:150px"></canvas>
              </div>
              <div class="summary-chart-card">
                <div class="sc-title">🏃 运动时长（近 7 天）</div>
                <canvas id="chartHealthEx" class="summary-canvas" style="height:150px"></canvas>
              </div>
            </div>
          </div>
          ` : ''}

          <div class="summary-section">
            <div class="summary-section-title">📈 数据可视化</div>
            <div class="summary-charts">
              <div class="summary-chart-card">
                <div class="sc-title">⏱️ 专注时长（近 7 天）</div>
                <canvas id="chartFocusBars" class="summary-canvas" style="height:150px"></canvas>
              </div>
              <div class="summary-chart-card">
                <div class="sc-title">😊 心情趋势（近 30 天）</div>
                <canvas id="chartMoodLine" class="summary-canvas" style="height:170px"></canvas>
              </div>
            </div>
          </div>

          <div class="summary-section">
            <div class="summary-section-title">🔥 习惯打卡（近一年）</div>
            <div class="summary-heatmap-card">
              ${Charts.renderHabitHeatmap()}
            </div>
          </div>

          <div class="summary-section">
            <div class="summary-section-title">📊 与上周期对比</div>
            <div class="compare-grid">
              <div class="compare-item"><div class="compare-label">📝 字数</div><div class="compare-values"><span class="cmp-cur">${s.diaryWords}</span><span class="cmp-prev">上期 ${prev.diaryWords}</span>${diffLabel(s.diaryWords, prev.diaryWords)}</div></div>
              <div class="compare-item"><div class="compare-label">✅ 待办完成</div><div class="compare-values"><span class="cmp-cur">${s.todoDone}</span><span class="cmp-prev">上期 ${prev.todoDone}</span>${diffLabel(s.todoDone, prev.todoDone)}</div></div>
              <div class="compare-item"><div class="compare-label">⏱️ 专注分钟</div><div class="compare-values"><span class="cmp-cur">${s.focusMin}</span><span class="cmp-prev">上期 ${prev.focusMin}</span>${diffLabel(s.focusMin, prev.focusMin)}</div></div>
              <div class="compare-item"><div class="compare-label">📚 随笔数</div><div class="compare-values"><span class="cmp-cur">${s.diaries.length}</span><span class="cmp-prev">上期 ${prev.diaryCount}</span>${diffLabel(s.diaries.length, prev.diaryCount)}</div></div>
              ${hasHealth ? `
              <div class="compare-item"><div class="compare-label">😴 睡眠</div><div class="compare-values"><span class="cmp-cur">${fmtNum(h.sleepHours)}h</span><span class="cmp-prev">上期 ${fmtNum(ph.sleepHours)}h</span>${diffLabel(h.sleepHours, ph.sleepHours)}</div></div>
              <div class="compare-item"><div class="compare-label">🏃 运动</div><div class="compare-values"><span class="cmp-cur">${h.exerciseMin}min</span><span class="cmp-prev">上期 ${ph.exerciseMin}min</span>${diffLabel(h.exerciseMin, ph.exerciseMin)}</div></div>
              <div class="compare-item"><div class="compare-label">💧 饮水</div><div class="compare-values"><span class="cmp-cur">${fmtNum(h.waterMl)}ml</span><span class="cmp-prev">上期 ${fmtNum(ph.waterMl)}ml</span>${diffLabel(h.waterMl, ph.waterMl)}</div></div>
              <div class="compare-item"><div class="compare-label">🔥 摄入</div><div class="compare-values"><span class="cmp-cur">${fmtNum(h.calories)}</span><span class="cmp-prev">上期 ${fmtNum(ph.calories)}</span>${diffLabel(h.calories, ph.calories)}</div></div>
              ` : ''}
            </div>
          </div>

          ${s.moodList.length ? `
            <div class="summary-section">
              <div class="summary-section-title">😊 心情分布</div>
              <div class="summary-moods">
                ${s.moodList.map(m => `<span class="summary-mood">${m.emoji}<span class="sm-count">×${m.count}</span></span>`).join('')}
              </div>
            </div>` : ''}

          ${s.metricRows.length ? `
            <div class="summary-section">
              <div class="summary-section-title">📊 指标快照</div>
              <div class="summary-metrics">
                ${s.metricRows.map(m => `
                  <div class="summary-metric">
                    <div class="sm-name">${esc(m.name)}</div>
                    <div class="sm-value">${fmtNum(m.value)}<span class="sm-unit">${esc(m.unit || '')}</span></div>
                  </div>`).join('')}
              </div>
            </div>` : ''}

          ${s.diaries.length ? `
            <div class="summary-section">
              <div class="summary-section-title">📝 随笔 · ${s.diaries.length} 条</div>
              ${s.diaries.slice(0, 8).map(d => `
                <div class="summary-diary">
                  <span class="sd-date">${esc(d.date)}</span>
                  ${esc(d.content.slice(0, 110))}${d.content.length > 110 ? '...' : ''}
                </div>
              `).join('')}
              ${s.diaries.length > 8 ? `<div class="sd-more">还有 ${s.diaries.length - 8} 条...</div>` : ''}
            </div>` : ''}

          ${!s.diaries.length && !s.moodList.length && !s.metricRows.length && !s.todoTotal && !s.focusMin && !s.habitCount && !hasHealth
            ? '<div class="summary-empty">这段时间还没有任何记录 ✨</div>'
            : ''}
        </div>
      </div>`;
  },

  mounted() {
    requestAnimationFrame(() => {
      Charts.drawFocusBars(document.getElementById('chartFocusBars'));
      Charts.drawMoodLine(document.getElementById('chartMoodLine'));
      Charts.drawHealthSleepBars(document.getElementById('chartHealthSleep'));
      Charts.drawHealthWaterBars(document.getElementById('chartHealthWater'));
      Charts.drawHealthCalBars(document.getElementById('chartHealthCal'));
      Charts.drawHealthExBars(document.getElementById('chartHealthEx'));
    });
  },

  actions: {
    'sum-range': (el) => {
      State.summaryRange = el.dataset.range;
      rerender();
    },
    'sum-apply': () => {
      const s = document.getElementById('sumStart').value;
      const e = document.getElementById('sumEnd').value;
      if (!s || !e) { toast('请选择日期', 'warning'); return; }
      if (s > e) { toast('开始不能晚于结束', 'warning'); return; }
      State.summaryRange = 'custom';
      State.summaryStart = s;
      State.summaryEnd = e;
      rerender();
    },

    'sum-ai-weekly': async () => {
      if (!AIHub.isEnabled()) { toast('请先到设置启用 AI', 'warning'); return; }
      showModal('weeklyReport', `
        <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">📅 AI 周报生成中…</h3>
        <div class="ai-loading" style="padding:30px;text-align:center">
          <div style="font-size:32px;margin-bottom:8px">🤖</div>
          <div>正在阅读你的近 7 天数据…</div>
        </div>
      `);
      try {
        const text = await AIHub.generateWeeklyReport();
        hideModal();
        showModal('weeklyReport', `
          <h3 style="font-size:16px;margin-bottom:14px;font-weight:800">📅 本周回顾</h3>
          <div style="font-size:13px;color:var(--text-sec);line-height:1.9;white-space:pre-wrap;background:var(--bg-input);padding:16px;border-radius:12px;border:1px solid var(--border)">${esc(text)}</div>
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
            <button class="btn btn-sm" data-action="weekly-report-copy" data-text="${esc(text)}" type="button">📋 复制</button>
            <button class="btn btn-sm" data-action="modal-close" type="button">关闭</button>
          </div>
        `, 'lg');
      } catch (e) {
        hideModal();
        toast('生成失败：' + e.message, 'error');
      }
    },

    'sum-ai-mood': async () => {
      if (!AIHub.isEnabled()) { toast('请先到设置启用 AI', 'warning'); return; }
      showModal('moodAnalysis', `
        <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">💭 AI 情绪分析中…</h3>
        <div class="ai-loading" style="padding:30px;text-align:center">
          <div style="font-size:32px;margin-bottom:8px">🤖</div>
          <div>正在阅读你的近 7 天心情记录…</div>
        </div>
      `);
      try {
        const text = await AIHub.analyzeMood();
        hideModal();
        showModal('moodAnalysis', `
          <h3 style="font-size:16px;margin-bottom:14px;font-weight:800">💭 情绪分析</h3>
          <div style="font-size:13px;color:var(--text-sec);line-height:1.9;white-space:pre-wrap;background:var(--bg-input);padding:16px;border-radius:12px;border:1px solid var(--border)">${esc(text)}</div>
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
            <button class="btn btn-sm" data-action="weekly-report-copy" data-text="${esc(text)}" type="button">📋 复制</button>
            <button class="btn btn-sm" data-action="modal-close" type="button">关闭</button>
          </div>
        `, 'lg');
      } catch (e) {
        hideModal();
        toast('分析失败：' + e.message, 'error');
      }
    },

    /* ⭐ 健康周报 */
    'sum-ai-health': async () => {
      if (!AIHub.isEnabled()) { toast('请先到设置启用 AI', 'warning'); return; }
      showModal('healthReport', `
        <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">💚 AI 健康周报生成中…</h3>
        <div class="ai-loading" style="padding:30px;text-align:center">
          <div style="font-size:32px;margin-bottom:8px">🥗</div>
          <div>正在阅读你的近 7 天健康数据…</div>
        </div>
      `);
      try {
        const text = await AIHub.generateHealthReport();
        hideModal();
        showModal('healthReport', `
          <h3 style="font-size:16px;margin-bottom:14px;font-weight:800">💚 健康周报</h3>
          <div style="font-size:13px;color:var(--text-sec);line-height:1.9;white-space:pre-wrap;background:var(--bg-input);padding:16px;border-radius:12px;border:1px solid var(--border)">${esc(text)}</div>
          <div class="health-hint-box" style="margin-top:12px;font-size:11px">
            ⚠️ AI 建议仅供参考，不构成医疗或营养专业建议。特殊体质请咨询医生。
          </div>
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">
            <button class="btn btn-sm" data-action="weekly-report-copy" data-text="${esc(text)}" type="button">📋 复制</button>
            <button class="btn btn-sm" data-action="modal-close" type="button">关闭</button>
          </div>
        `, 'lg');
      } catch (e) {
        hideModal();
        toast('生成失败：' + e.message, 'error');
      }
    },

    'weekly-report-copy': (el) => {
      const text = el.dataset.text || '';
      navigator.clipboard.writeText(text).then(
        () => toast('已复制到剪贴板', 'success'),
        () => toast('复制失败', 'error')
      );
    }
  }
};