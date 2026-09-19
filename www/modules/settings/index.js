import { DB, State, save, flush, S, setLastBackupAt,
         dumpModule, validateImportData, previewImport,
         autoBackupBeforeImport, restoreAutoBackup, getAutoBackupInfo,
         importData, MODULE_KEYS, ENTITIES,
         saveUserConfig } from '../../core/db.js';
import { esc, today, uid } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { show as showModal, hide as hideModal } from '../../ui/modal.js';
import { switchTab, rerender } from '../../ui/shell.js';
import { emit } from '../../core/bus.js';
import * as Sec from './sections.js';
import onboarding from '../onboarding/index.js';
import { validateFormula } from '../../core/formula.js';
import { APP_VERSION, BUILD_DATE, SCHEMA_VERSION } from '../../core/version.js';
import * as Theme from '../../core/theme.js';

const MODULE_LABEL = {
  all: '全部',
  diary: '日记',
  habitgoal: '习惯目标',
  calsch: '课表',
  health: '健康',
  review: '复习',
  metrics: '指标'
};

let _pendingImportJson = null;

['decks','cards','reviewLogs','healthRecords','healthGoals'].forEach(k => {
  if (!Array.isArray(DB[k])) DB[k] = [];
});

export default {
  id: 'settings',
  name: '设置',
  icon: '⚙️',
  order: 99,
  hidden: true,

  render() {
    return `
      <div class="home-grid">
        ${Sec.renderBackBar()}
        ${Sec.renderShareCard()}
        ${Sec.renderAI()}
        ${Sec.renderAppearance()}
        ${Sec.renderOnboarding()}
        ${Sec.renderWeather()}
        ${Sec.renderProfile()}
        ${Sec.renderSemester()}
        ${Sec.renderMetrics()}
        ${Sec.renderTimer()}
        ${Sec.renderData()}
        ${Sec.renderAbout()}
      </div>`;
  },

  mounted() {
    const fi = document.getElementById('importFile');
    if (fi) fi.addEventListener('change', handleImportFile);
  },

  actions: {
    'settings-back': () => switchTab('diary'),

    'restart-onboarding': () => {
      if (!State.user) return;
      S.remove('onboarding_done_v4_' + State.user.id);
      onboarding.start();
    },

    'copy-app-info': () => {
      const info = [
        `仙小助 v${APP_VERSION}`,
        `构建日期：${BUILD_DATE}`,
        `数据格式：v${SCHEMA_VERSION}`,
        '',
        '这是「仙小助」——生涯规划与自我提升助手',
        '功能：随笔 / 心情 / 待办 / 目标 / 习惯 / 专注 / 总结 / 复习室 / 健康 / AI 助手',
        '完全本地运行，数据不上传服务器。'
      ].join('\n');
      navigator.clipboard.writeText(info).then(
        () => toast('已复制应用信息', 'success'),
        () => toast('复制失败', 'error')
      );
    },

    // ===== AI =====
    'ai-save': () => {
      const cur = State.aiConfig || {};
      State.aiConfig = {
        endpoint: (document.getElementById('aiEndpoint').value || '').trim(),
        apiKey: (document.getElementById('aiKey').value || '').trim(),
        model: (document.getElementById('aiModel').value || 'deepseek-chat').trim(),
        enabled: !!cur.enabled,
        smartComplete: !!cur.smartComplete,
        smartCompleteLimit: parseInt(cur.smartCompleteLimit) > 0 ? parseInt(cur.smartCompleteLimit) : 20
      };
      /* ⭐ 按用户存储 */
      saveUserConfig();
      toast('已保存 AI 配置', 'success');
      rerender();
    },
    'ai-toggle': () => {
      const cur = State.aiConfig || {};
      const cfg = {
        endpoint: (document.getElementById('aiEndpoint').value || '').trim(),
        apiKey: (document.getElementById('aiKey').value || '').trim(),
        model: (document.getElementById('aiModel').value || 'deepseek-chat').trim(),
        enabled: !cur.enabled,
        smartComplete: !!cur.smartComplete,
        smartCompleteLimit: parseInt(cur.smartCompleteLimit) > 0 ? parseInt(cur.smartCompleteLimit) : 20
      };
      State.aiConfig = cfg;
      saveUserConfig();
      if (cfg.enabled && (!cfg.apiKey || !cfg.endpoint)) {
        toast('请填写接口地址和 API Key', 'warning');
      } else {
        toast(cfg.enabled ? 'AI 已启用' : 'AI 已停用', 'success');
      }
      rerender();
    },
    'ai-smart-toggle': () => {
      const cur = State.aiConfig || {};
      const cfg = {
        ...cur,
        smartComplete: !cur.smartComplete,
        smartCompleteLimit: parseInt(cur.smartCompleteLimit) > 0 ? parseInt(cur.smartCompleteLimit) : 20
      };
      State.aiConfig = cfg;
      saveUserConfig();
      toast(cfg.smartComplete ? '智能补全已开启' : '智能补全已关闭', 'success');
      rerender();
    },
    'ai-smart-limit-save': () => {
      const el = document.getElementById('aiSmartLimit');
      if (!el) return;
      const v = parseInt(el.value);
      if (!Number.isFinite(v) || v < 1 || v > 500) {
        toast('请输入 1-500 之间的数字', 'warning');
        return;
      }
      const cur = State.aiConfig || {};
      State.aiConfig = { ...cur, smartCompleteLimit: v };
      saveUserConfig();
      toast(`每日额度已设置为 ${v} 次`, 'success');
      rerender();
    },

    // ===== 外观 =====
    'settings-accent': (el) => {
      const k = el.dataset.accent;
      State.accent = k;
      S.set('accent', k);
      Theme.setAccent(k);
      document.querySelectorAll('.accent-dot').forEach(d => d.classList.toggle('active', d.dataset.accent === k));
      toast('主题色已切换', 'success');
    },
    'settings-theme': (el) => {
      const t = el.dataset.theme;
      State.theme = t;
      S.set('theme', t);
      import('../../core/theme.js').then(m => m.apply());
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === t));
      toast(t === 'dark' ? '深色模式' : t === 'light' ? '浅色模式' : '跟随系统', 'success');
    },

    // ===== 天气 =====
    'save-amap-key': () => {
      State.amapKey = (document.getElementById('sAmapKey').value || '').trim();
      /* ⭐ 按用户存储 */
      saveUserConfig();
      S.remove('geo_cache');
      S.remove('weather_cache_v20');
      S.remove('weather_cache_time_v20');
      State.weather = null;
      toast(State.amapKey ? '高德 Key 已保存' : '已清空', 'success');
      rerender();
    },
    'save-weather': async () => {
      const city = (document.getElementById('sCity').value || '').trim();
      if (!city) { toast('请输入城市', 'warning'); return; }
      const lat = parseFloat(document.getElementById('sWeatherLat').value) || null;
      const lon = parseFloat(document.getElementById('sWeatherLon').value) || null;
      const adcode = (document.getElementById('sWeatherAdcode').value || '').replace(/\D/g, '').slice(0, 6);
      const u = DB.users.find(x => x.id === State.user.id);
      if (u) { u.city = city; u.weatherLat = lat; u.weatherLon = lon; u.weatherAdcode = adcode || ''; }
      State.user.city = city;
      State.user.weatherLat = lat;
      State.user.weatherLon = lon;
      State.user.weatherAdcode = adcode || '';
      save('users');
      S.remove('weather_cache_v20');
      S.remove('weather_cache_time_v20');
      State.weather = null;
      toast('已保存，正在刷新天气…', 'success');
      try {
        const mod = await import('../diary/weather.js');
        await mod.load(true);
      } catch (e) { console.warn(e); }
    },
    'weather-clear-geo': () => {
      S.remove('geo_cache');
      toast('定位缓存已清除', 'success');
    },

    // ===== 个人 =====
    'save-profile': () => {
      const w = parseFloat(document.getElementById('sWeight').value) || 0;
      const h = parseFloat(document.getElementById('sHeight').value) || 0;
      const g = document.getElementById('sGender').value;
      const a = parseInt(document.getElementById('sAge').value) || 0;
      const u = DB.users.find(x => x.id === State.user.id);
      if (u) { u.weight = w; u.height = h; u.gender = g; u.age = a; }
      State.user.weight = w; State.user.height = h; State.user.gender = g; State.user.age = a;
      save('users');
      toast('已保存', 'success');
      rerender();
    },
    'save-semester': () => {
      const d = document.getElementById('sSemesterStart').value;
      if (!d) { toast('请选择日期', 'warning'); return; }
      const u = DB.users.find(x => x.id === State.user.id);
      if (u) u.semesterStart = d;
      State.user.semesterStart = d;
      save('users');
      toast('已保存', 'success');
    },

    // ===== 指标 =====
    'metric-add': () => {
      const name = document.getElementById('sMetricName').value.trim();
      const unit = document.getElementById('sMetricUnit').value.trim();
      const target = parseFloat(document.getElementById('sMetricTarget').value) || 0;
      const dir = document.getElementById('sMetricDir').value;
      if (!name) { toast('请输入名称', 'warning'); return; }
      if (DB.metrics.some(m => m.user_id === State.user.id && m.name === name)) {
        toast('已存在同名指标', 'warning'); return;
      }
      DB.metrics.push({
        id: uid(),
        user_id: State.user.id,
        name, unit,
        target_value: target,
        target_dir: dir,
        pinned: false,
        isDerived: false,
        createdAt: new Date().toISOString()
      });
      save('metrics');
      emit('db:changed');
      toast('已添加', 'success');
      rerender();
    },

    'metric-add-formula': () => {
      const name = document.getElementById('sFormulaName').value.trim();
      const unit = document.getElementById('sFormulaUnit').value.trim();
      const formula = document.getElementById('sFormulaExpr').value.trim();
      const target = parseFloat(document.getElementById('sFormulaTarget').value) || 0;
      const dir = document.getElementById('sFormulaDir').value;
      if (!name) { toast('请输入名称', 'warning'); return; }
      if (!formula) { toast('请输入公式', 'warning'); return; }
      if (DB.metrics.some(m => m.user_id === State.user.id && m.name === name)) {
        toast('已存在同名指标', 'warning'); return;
      }
      const v = validateFormula(formula);
      if (!v.ok) { toast('公式错误：' + v.error, 'error'); return; }
      DB.metrics.push({
        id: uid(), user_id: State.user.id, name, unit,
        target_value: target, target_dir: dir,
        pinned: false, isDerived: true, formula,
        createdAt: new Date().toISOString()
      });
      save('metrics');
      emit('db:changed');
      toast('已添加公式指标', 'success');
      rerender();
    },

    'metric-edit': (el) => {
      import('../diary/metric.js').then(({ actions }) => {
        if (actions['metric-edit']) actions['metric-edit'](el);
      });
    },

    'metric-toggle-pin': (el, e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      const m = DB.metrics.find(x => x.id === el.dataset.id);
      if (!m) return;
      m.pinned = !m.pinned;
      save('metrics');
      emit('db:changed');
      toast(m.pinned ? '已置顶' : '已取消置顶', 'success');
      rerender();
    },

    'metric-remove': (el) => {
      const m = DB.metrics.find(x => x.id === el.dataset.id && x.user_id === State.user.id);
      if (!m) return;
      if (!confirm(`删除指标「${m.name}」及其所有数据？`)) return;
      DB.metrics = DB.metrics.filter(x => x.id !== m.id);
      DB.metricValues = DB.metricValues.filter(v => v.metric_id !== m.id);
      save('metrics', 'metricValues');
      emit('db:changed');
      toast('已删除', 'success');
      rerender();
    },

    // ===== 番茄钟 =====
    'save-timer': () => {
      const w = Math.max(1, Math.min(180, parseInt(document.getElementById('sWorkMin').value) || 25));
      const b = Math.max(1, Math.min(60, parseInt(document.getElementById('sBreakMin').value) || 5));
      State.timer.work = w * 60;
      State.timer.break = b * 60;
      if (!State.timer.pomo.phase) {
        State.timer.pomo.seconds = w * 60;
        State.timer.pomo.total = w * 60;
      }
      S.set('timer_work', w);
      S.set('timer_break', b);
      toast('已保存', 'success');
    },

    // ===== 数据：导出 =====
    'data-export': (el) => {
      if (!State.user) return;
      const moduleName = el.dataset.module || 'all';

      let data;
      try {
        data = dumpModule(State.user.id, moduleName);
      } catch (e) {
        toast('导出失败：' + e.message, 'error');
        return;
      }

      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const label = MODULE_LABEL[moduleName] || moduleName;
      a.download = `仙小助备份_${label}_v${APP_VERSION}_${today()}.json`;
      a.click();
      URL.revokeObjectURL(url);

      setLastBackupAt(Date.now());
      toast(`✅ 已导出「${label}」数据`, 'success');
      rerender();
    },

    'data-import': () => {
      const fi = document.getElementById('importFile');
      if (fi) fi.click();
    },

    'data-import-confirm': (el) => {
      const json = _pendingImportJson;
      if (!json) { toast('导入数据已失效，请重新选择文件', 'warning'); hideModal(); return; }

      const strategy = el.dataset.strategy || 'merge';

      const backupOk = autoBackupBeforeImport();
      if (!backupOk) {
        if (!confirm('自动备份失败（可能是空间不足），仍要继续导入吗？')) return;
      }

      const r = importData(json, State.user.id, strategy);

      if (!r.ok) {
        toast('导入失败：' + (r.error || '未知错误') + '（数据已回滚）', 'error', { duration: 8000 });
        return;
      }

      hideModal();
      _pendingImportJson = null;
      toast(`✅ 导入完成：新增 ${r.added} · 更新 ${r.updated} · 跳过 ${r.skipped}`, 'success', { duration: 6000 });
      emit('db:changed');
      setTimeout(() => location.reload(), 600);
    },

    'data-import-cancel': () => {
      _pendingImportJson = null;
      hideModal();
    },

    'data-restore-auto': () => {
      const info = getAutoBackupInfo();
      if (!info || !info.at) { toast('没有可用的自动备份', 'info'); return; }
      const timeStr = new Date(info.at).toLocaleString('zh-CN');
      if (!confirm(`恢复自动备份（${timeStr}）？\n\n当前数据会被替换为此备份。\n此操作不可撤销。`)) return;

      const ok = restoreAutoBackup();
      if (ok) {
        toast('✅ 已恢复自动备份', 'success');
        emit('db:changed');
        setTimeout(() => location.reload(), 600);
      } else {
        toast('恢复失败', 'error');
      }
    },

    'data-clear': () => {
      if (!confirm('⚠️ 清空当前账号的所有数据？此操作不可恢复！建议先导出。')) return;
      if (!confirm('再次确认：真的要清空吗？')) return;

      autoBackupBeforeImport();

      const u = State.user.id;
      const SCOPED = [
        'todos','diaries','moods','metrics','focusSessions','goals','habits','habitLogs',
        'courses','badges','decks','cards','reviewLogs','healthRecords','healthGoals'
      ];
      SCOPED.forEach(k => {
        if (Array.isArray(DB[k])) {
          DB[k] = DB[k].filter(x => x.user_id !== u);
        }
      });
      const myMetricIds = new Set(DB.metrics.filter(m => m.user_id === u).map(m => m.id));
      DB.metricValues = DB.metricValues.filter(v => !myMetricIds.has(v.metric_id));

      ENTITIES.forEach(k => save(k));
      flush();
      toast('已清空当前账号数据（可从自动备份恢复）', 'success');
      emit('db:changed');
      setTimeout(() => location.reload(), 600);
    }
  }
};

function handleImportFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    let json;
    try {
      json = JSON.parse(ev.target.result);
    } catch (err) {
      toast('文件不是有效的 JSON：' + err.message, 'error');
      return;
    }

    const v = validateImportData(json);
    if (!v.ok) {
      toast('数据校验失败：' + v.errors.join('；'), 'error', { duration: 6000 });
      return;
    }

    const preview = previewImport(json, State.user.id, 'merge');

    _pendingImportJson = json;
    showImportPreviewModal(file.name, json, preview);
  };
  reader.readAsText(file, 'UTF-8');
}

function showImportPreviewModal(fileName, json, preview) {
  const moduleLabel = json._module ? (MODULE_LABEL[json._module] || json._module) : '未知';
  const exportedAt = json._exportedAt ? new Date(json._exportedAt).toLocaleString('zh-CN') : '未知';
  const version = json._version || '未知';

  const detailRows = Object.keys(preview.perKey).map(k => {
    const d = preview.perKey[k];
    const total = d.add + d.update + d.skip;
    if (total === 0) return '';
    const parts = [];
    if (d.add) parts.push(`<span style="color:var(--success)">+${d.add}</span>`);
    if (d.update) parts.push(`<span style="color:var(--warning)">~${d.update}</span>`);
    if (d.skip) parts.push(`<span style="color:var(--text-muted)">跳过 ${d.skip}</span>`);
    return `
      <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed var(--border);font-size:12px">
        <span style="color:var(--text-sec);font-family:var(--mono)">${k}</span>
        <span style="font-family:var(--mono);font-weight:700">${parts.join(' · ')}</span>
      </div>`;
  }).join('');

  const hasAdd = preview.willAdd > 0;

  showModal('importPreview', `
    <h3 style="font-size:16px;margin-bottom:6px;font-weight:800">📥 导入预览</h3>
    <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:14px;line-height:1.6">
      文件：<b style="color:var(--text)">${esc(fileName)}</b><br>
      来源：<b style="color:var(--text)">${esc(moduleLabel)}</b> · 版本 v${esc(String(version))}<br>
      导出时间：${esc(exportedAt)}
    </div>

    <div style="display:flex;gap:12px;padding:14px;background:var(--bg-input);border-radius:10px;border:1px solid var(--border);margin-bottom:14px">
      <div style="flex:1;text-align:center">
        <div style="font-size:22px;font-weight:800;font-family:var(--mono);color:var(--success)">${preview.willAdd}</div>
        <div style="font-size:11px;color:var(--text-muted);font-weight:700;margin-top:2px">将新增</div>
      </div>
      <div style="flex:1;text-align:center">
        <div style="font-size:22px;font-weight:800;font-family:var(--mono);color:var(--warning)">${preview.willUpdate}</div>
        <div style="font-size:11px;color:var(--text-muted);font-weight:700;margin-top:2px">将更新</div>
      </div>
      <div style="flex:1;text-align:center">
        <div style="font-size:22px;font-weight:800;font-family:var(--mono);color:var(--text-muted)">${preview.willSkip}</div>
        <div style="font-size:11px;color:var(--text-muted);font-weight:700;margin-top:2px">将跳过</div>
      </div>
    </div>

    <div style="font-size:11.5px;font-weight:700;color:var(--text-sec);margin-bottom:6px;text-transform:uppercase;letter-spacing:.4px">
      明细
    </div>
    <div style="max-height:180px;overflow-y:auto;padding-right:4px;margin-bottom:14px">
      ${detailRows || '<div style="text-align:center;padding:12px;color:var(--text-muted);font-size:12px">无数据</div>'}
    </div>

    <div class="hint-box" style="background:rgba(96,165,250,.08);border-left-color:var(--info);margin-bottom:14px">
      💡 导入前会自动备份当前数据。如果导入后不满意，可在设置页点「♻️ 恢复自动备份」。
    </div>

    <div style="font-size:12px;color:var(--text-sec);margin-bottom:10px;font-weight:700">选择导入策略：</div>
    <div style="display:flex;gap:8px;flex-direction:column">
      <button class="btn" data-action="data-import-confirm" data-strategy="merge" type="button" ${hasAdd ? '' : 'disabled'} style="justify-content:flex-start;text-align:left;padding:10px 14px">
        <div>
          <div style="font-weight:700;font-size:13px">🔀 合并（推荐）</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">新增不存在的条目，已存在的不动</div>
        </div>
      </button>
      <button class="btn" data-action="data-import-confirm" data-strategy="overwrite" type="button" style="justify-content:flex-start;text-align:left;padding:10px 14px">
        <div>
          <div style="font-weight:700;font-size:13px">♻️ 覆盖</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">同 ID 的条目用备份文件里的替换</div>
        </div>
      </button>
    </div>

    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
      <button class="btn btn-sm" data-action="data-import-cancel" type="button">取消</button>
    </div>
  `, 'lg');
}