import { DB, State, S, countUserData, getAutoBackupInfo } from '../../core/db.js';
import { esc, today, uid } from '../../core/utils.js';
import { APP_VERSION, BUILD_DATE, SCHEMA_VERSION } from '../../core/version.js';

export function renderBackBar() {
  return `
    <div class="panel" style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px">
      <span style="font-size:14px;font-weight:800">⚙️ 设置</span>
      <button class="btn btn-sm" data-action="settings-back" type="button">← 返回</button>
    </div>`;
}

export function renderAI() {
  const ai = State.aiConfig || {};
  const smart = !!ai.smartComplete;
  const limit = parseInt(ai.smartCompleteLimit) > 0 ? parseInt(ai.smartCompleteLimit) : 20;

  let todayUsage = 0;
  try {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const t = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const u = S.get('smart_complete_usage_' + (State.user?.id || 'guest'), null);
    if (u && u.date === t) todayUsage = u.count;
  } catch (e) {}

  return `
    <div class="panel">
      <div class="panel-title"><span class="title-icon">🤖</span>AI 助手接入</div>
      <div class="hint-box">
        支持 OpenAI 兼容接口。推荐 <code>https://api.deepseek.com</code>，模型 <code>deepseek-chat</code>。<br>
        开启后，AI 助手面板「生成」一次调用同时返回建议 + 解析。
      </div>
      <div class="settings-form">
        <div class="form-row">
          <label>接口地址</label>
          <input type="text" class="input full" id="aiEndpoint" value="${esc(ai.endpoint || '')}" placeholder="https://api.deepseek.com">
        </div>
        <div class="form-row">
          <label>API Key</label>
          <input type="password" class="input full" id="aiKey" value="${esc(ai.apiKey || '')}" placeholder="sk-...">
        </div>
        <div class="form-row">
          <label>模型</label>
          <input type="text" class="input" id="aiModel" value="${esc(ai.model || 'deepseek-chat')}" style="max-width:220px">
        </div>
        <div class="form-row">
          <button class="btn btn-sm ${ai.enabled ? 'btn-primary' : ''}" data-action="ai-toggle" type="button">${ai.enabled ? '✅ 已启用' : '⏸ 未启用'}</button>
          <button class="btn btn-sm btn-primary" data-action="ai-save" type="button">💾 保存</button>
        </div>

        <div class="settings-row" style="border-top:1px dashed var(--border);padding-top:12px;margin-top:12px">
          <label>智能补全</label>
          <button class="btn btn-sm ${smart ? 'btn-primary' : ''}" data-action="ai-smart-toggle" type="button">
            ${smart ? '✅ 已开启（写随笔时 2 秒无输入触发续写）' : '⏸ 已关闭'}
          </button>
        </div>

        ${smart ? `
          <div class="settings-row" style="padding-top:10px">
            <label>每日额度</label>
            <input type="number" class="input" id="aiSmartLimit" value="${limit}" min="1" max="500" style="max-width:100px">
            <span style="font-size:12px;color:var(--text-muted);font-weight:600">次 / 天</span>
            <button class="btn btn-sm btn-primary" data-action="ai-smart-limit-save" type="button">保存</button>
          </div>
          <div class="settings-row" style="padding-top:0">
            <label style="min-width:70px">今日已用</label>
            <div style="flex:1">
              <div class="quota-bar-wrap">
                <div class="quota-bar-fill" style="width:${Math.min(100, todayUsage / limit * 100)}%;background:${todayUsage >= limit ? 'var(--danger)' : todayUsage / limit > 0.7 ? 'var(--warning)' : 'var(--success)'}"></div>
              </div>
              <div style="font-size:11.5px;color:var(--text-muted);margin-top:4px;font-weight:600">
                ${todayUsage} / ${limit} 次
                ${todayUsage >= limit ? '<span style="color:var(--danger)">（已用完，明日重置）</span>' : ''}
              </div>
            </div>
          </div>
          <div style="font-size:11.5px;color:var(--text-muted);line-height:1.6;margin-top:6px">
            💡 智能补全每次停手 2 秒触发一次，消耗 token 较多。额度限制可防止意外消耗。
          </div>
        ` : ''}
      </div>
    </div>`;
}

export function renderWeather() {
  const u = State.user || {};
  return `
    <div class="panel">
      <div class="panel-title"><span class="title-icon">🌤️</span>天气</div>
      <div class="hint-box">
        天气数据来自 <b>高德（气象局）</b> 或 Open-Meteo。城市坐标由 AI 提供。
      </div>
      <div class="settings-form">
        <div class="form-row">
          <label>高德Key</label>
          <input type="password" class="input full" id="sAmapKey" value="${esc(State.amapKey || '')}" placeholder="Web 服务类型 Key">
          <button class="btn btn-sm btn-primary" data-action="save-amap-key" type="button">保存</button>
        </div>
        <div class="form-row">
          <label>城市</label>
          <input type="text" class="input" id="sCity" value="${esc(u.city || '北京')}" style="max-width:220px">
        </div>
        <div class="form-row">
          <label>adcode</label>
          <input type="text" class="input" id="sWeatherAdcode" value="${u.weatherAdcode || ''}" placeholder="6 位数字" style="max-width:130px" maxlength="6">
        </div>
        <div class="form-row">
          <label>纬度</label>
          <input type="number" class="input" id="sWeatherLat" value="${u.weatherLat != null && u.weatherLat !== '' ? u.weatherLat : ''}" step="0.0001" style="max-width:130px">
          <label>经度</label>
          <input type="number" class="input" id="sWeatherLon" value="${u.weatherLon != null && u.weatherLon !== '' ? u.weatherLon : ''}" step="0.0001" style="max-width:130px">
        </div>
        <div class="form-row">
          <button class="btn btn-sm btn-primary" data-action="save-weather" type="button">保存并刷新</button>
          <button class="btn btn-sm" data-action="weather-clear-geo" type="button">🗑️ 清除定位缓存</button>
        </div>
      </div>
    </div>`;
}

export function renderProfile() {
  const u = State.user || {};
  return `
    <div class="panel">
      <div class="panel-title"><span class="title-icon">👤</span>个人信息</div>
      <div class="settings-form">
        <div class="form-row">
          <label>体重</label><input type="number" class="input" id="sWeight" value="${u.weight || ''}" step="0.1" style="max-width:80px">
          <label>身高</label><input type="number" class="input" id="sHeight" value="${u.height || ''}" step="0.1" style="max-width:80px">
          <label>性别</label>
          <select class="input" id="sGender" style="max-width:80px">
            <option value="male"${u.gender === 'male' ? ' selected' : ''}>男</option>
            <option value="female"${u.gender === 'female' ? ' selected' : ''}>女</option>
          </select>
          <label>年龄</label><input type="number" class="input" id="sAge" value="${u.age || ''}" style="max-width:70px">
        </div>
        <button class="btn btn-primary btn-sm" data-action="save-profile" type="button">保存</button>
      </div>
    </div>`;
}

export function renderSemester() {
  const u = State.user || {};
  return `
    <div class="panel">
      <div class="panel-title"><span class="title-icon">📚</span>学期</div>
      <div class="settings-form">
        <div class="form-row">
          <label>开学日期</label>
          <input type="date" class="input" id="sSemesterStart" value="${u.semesterStart || today()}" style="max-width:160px">
          <button class="btn btn-sm btn-primary" data-action="save-semester" type="button">保存</button>
        </div>
      </div>
    </div>`;
}

export function renderMetrics() {
  const uid = State.user?.id;
  const list = DB.metrics.filter(m => m.user_id === uid);
  const sorted = [...list].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  });

  return `
    <div class="panel">
      <div class="panel-title"><span class="title-icon">📊</span>指标管理</div>
      <div class="hint-box" style="margin-bottom:12px">
        普通指标：每天手动记录数值。<br>
        <b>公式指标</b>：根据其他指标自动计算。例如 <code>体重 / (身高/100)^2</code> 自动算 BMI。
      </div>

      <div style="font-size:12.5px;font-weight:700;color:var(--text-sec);margin-bottom:8px">+ 新建普通指标</div>
      <div class="settings-form">
        <div class="form-row">
          <label>名称</label>
          <input type="text" class="input" id="sMetricName" style="max-width:110px">
          <label>单位</label>
          <input type="text" class="input" id="sMetricUnit" style="max-width:70px">
        </div>
        <div class="form-row">
          <label>目标</label>
          <input type="number" class="input" id="sMetricTarget" style="max-width:95px" placeholder="留空=无目标">
          <label>方向</label>
          <select class="input" id="sMetricDir" style="max-width:130px">
            <option value="higher">↑ 越高越好</option>
            <option value="lower">↓ 越低越好</option>
          </select>
          <button class="btn btn-primary btn-sm" data-action="metric-add" type="button">+ 添加</button>
        </div>
      </div>

      <div style="font-size:12.5px;font-weight:700;color:var(--text-sec);margin:16px 0 8px">ƒ 新建公式指标</div>
      <div class="settings-form">
        <div class="form-row">
          <label>名称</label>
          <input type="text" class="input" id="sFormulaName" style="max-width:110px" placeholder="如 BMI">
          <label>单位</label>
          <input type="text" class="input" id="sFormulaUnit" style="max-width:70px" placeholder="如 kg/m²">
        </div>
        <div class="form-row">
          <label>公式</label>
          <input type="text" class="input full" id="sFormulaExpr" placeholder="例如 体重 / (身高/100)^2">
        </div>
        <div style="font-size:11.5px;color:var(--text-muted);line-height:1.6;margin-bottom:8px">
          变量用其他指标的名字（中文或英文都行）：<br>
          支持 <code>+ - * / ( ) ^</code> 和函数 <code>min max abs round floor ceil sqrt pow</code>
        </div>
        <div class="form-row">
          <label>目标</label>
          <input type="number" class="input" id="sFormulaTarget" style="max-width:95px" placeholder="留空=无目标">
          <label>方向</label>
          <select class="input" id="sFormulaDir" style="max-width:130px">
            <option value="higher">↑ 越高越好</option>
            <option value="lower">↓ 越低越好</option>
          </select>
          <button class="btn btn-primary btn-sm" data-action="metric-add-formula" type="button">+ 添加公式</button>
        </div>
      </div>

      <div style="font-size:12.5px;font-weight:700;color:var(--text-sec);margin:18px 0 8px">已有指标（${list.length}）</div>
      <div id="settingsMetricList" style="display:flex;flex-direction:column;gap:6px">
        ${sorted.map(m => `
          <div class="settings-metric-row" style="display:flex;align-items:center;gap:8px">
            <button class="metric-pin-btn small${m.pinned ? ' active' : ''}" data-action="metric-toggle-pin" data-id="${m.id}" type="button" title="${m.pinned ? '取消置顶' : '置顶'}">${m.pinned ? '📌' : '·'}</button>
            <span style="flex:1">
              ${esc(m.name)}
              ${m.unit ? `<span style="color:var(--text-muted)">(${esc(m.unit)})</span>` : ''}
              ${m.isDerived ? ' <span class="metric-formula-tag">ƒ</span>' : ''}
              ${m.target_value ? `<span style="color:var(--text-muted);font-size:11.5px"> · 目标 ${m.target_value} ${m.target_dir === 'lower' ? '↓' : '↑'}</span>` : ''}
            </span>
            <button class="btn btn-xs btn-ghost" data-action="metric-edit" data-id="${m.id}" type="button">✎</button>
            <button class="btn btn-xs btn-danger" data-action="metric-remove" data-id="${m.id}" type="button">删</button>
          </div>
        `).join('')}
      </div>
    </div>`;
}

export function renderTimer() {
  const st = State.timer;
  return `
    <div class="panel">
      <div class="panel-title"><span class="title-icon">⏱️</span>番茄钟</div>
      <div class="settings-form">
        <div class="form-row">
          <label>工作</label><input type="number" class="input" id="sWorkMin" value="${Math.round(st.work / 60)}" style="max-width:70px">
          <label>休息</label><input type="number" class="input" id="sBreakMin" value="${Math.round(st.break / 60)}" style="max-width:70px">
          <button class="btn btn-sm btn-primary" data-action="save-timer" type="button">保存</button>
        </div>
      </div>
    </div>`;
}

export function renderAppearance() {
  const accents = [
    { k: 'violet', c: '#7c6cf8', name: '紫' },
    { k: 'blue', c: '#3b82f6', name: '蓝' },
    { k: 'green', c: '#10b981', name: '绿' },
    { k: 'rose', c: '#f43f5e', name: '红' },
    { k: 'amber', c: '#f59e0b', name: '橙' }
  ];
  return `
    <div class="panel">
      <div class="panel-title"><span class="title-icon">🎨</span>外观</div>
      <div class="settings-row">
        <label>主题色</label>
        <div class="accent-picker">
          ${accents.map(a => `<div class="accent-dot${State.accent === a.k ? ' active' : ''}" data-action="settings-accent" data-accent="${a.k}" style="background:${a.c}" title="${a.name}"></div>`).join('')}
        </div>
      </div>
      <div class="settings-row">
        <label>主题模式</label>
        <div class="theme-picker">
          <button class="theme-btn${State.theme === 'dark' ? ' active' : ''}" data-action="settings-theme" data-theme="dark" type="button">🌙 深色</button>
          <button class="theme-btn${State.theme === 'light' ? ' active' : ''}" data-action="settings-theme" data-theme="light" type="button">☀️ 浅色</button>
          <button class="theme-btn${State.theme === 'auto' ? ' active' : ''}" data-action="settings-theme" data-theme="auto" type="button">🌓 跟随系统</button>
        </div>
      </div>
    </div>`;
}

export function renderOnboarding() {
  return `
    <div class="panel">
      <div class="panel-title"><span class="title-icon">🎓</span>新手引导</div>
      <div style="font-size:12.5px;color:var(--text-sec);line-height:1.7;margin-bottom:14px">
        重新查看功能导览，了解各个板块的用法。
      </div>
      <button class="btn btn-sm btn-primary" data-action="restart-onboarding" type="button">▶ 重新查看引导</button>
    </div>`;
}

export function renderShareCard() {
  const stats = State.user ? countUserData(State.user.id) : {};
  const lastBackup = State.lastBackupAt || 0;
  const lastBackupText = lastBackup
    ? `${new Date(lastBackup).toLocaleString('zh-CN')}（${Math.floor((Date.now() - lastBackup) / 86400000)} 天前）`
    : '从未备份';

  return `
    <div class="panel">
      <div class="panel-title"><span class="title-icon">📤</span>分享给朋友</div>
      <div class="hint-box" style="margin-bottom:14px">
        <b>场景：</b>你改了代码，想把「最新版应用 + 你的数据」一起发给朋友用。
      </div>

      <div style="font-size:13px;color:var(--text-sec);line-height:1.9;margin-bottom:14px">
        <div style="font-weight:800;color:var(--text);margin-bottom:8px">方式 A：发代码（推荐）</div>
        <div style="padding-left:16px">
          <div>1. 把整个 <code>www/</code> 文件夹压缩成 zip 发给朋友</div>
          <div>2. 朋友解压后<b>双击 index.html</b> 或用浏览器打开即可</div>
          <div style="color:var(--text-muted);font-size:12px;margin-top:4px">
            💡 每个用户的数据存在自己浏览器本地（localStorage），<b>互不影响</b>
          </div>
        </div>
      </div>

      <div style="font-size:13px;color:var(--text-sec);line-height:1.9;margin-bottom:14px">
        <div style="font-weight:800;color:var(--text);margin-bottom:8px">方式 B：带数据一起发</div>
        <div style="padding-left:16px">
          <div>1. 点下方「📤 导出全部数据」→ 得到 JSON 文件</div>
          <div>2. 把 <code>www/</code> 文件夹 + JSON 一起发给朋友</div>
          <div>3. 朋友打开应用后，进设置页点「📥 导入文件」选择 JSON</div>
        </div>
      </div>

      <div class="share-stats">
        <div class="share-stat-item">
          <span class="share-stat-num">${stats.diaries || 0}</span>
          <span class="share-stat-label">随笔</span>
        </div>
        <div class="share-stat-item">
          <span class="share-stat-num">${stats.todos || 0}</span>
          <span class="share-stat-label">待办</span>
        </div>
        <div class="share-stat-item">
          <span class="share-stat-num">${stats.moods || 0}</span>
          <span class="share-stat-label">心情</span>
        </div>
        <div class="share-stat-item">
          <span class="share-stat-num">${stats.metrics || 0}</span>
          <span class="share-stat-label">指标</span>
        </div>
        <div class="share-stat-item">
          <span class="share-stat-num">${stats.goals || 0}</span>
          <span class="share-stat-label">目标</span>
        </div>
        <div class="share-stat-item">
          <span class="share-stat-num">${stats.habits || 0}</span>
          <span class="share-stat-label">习惯</span>
        </div>
        <div class="share-stat-item">
          <span class="share-stat-num">${stats.courses || 0}</span>
          <span class="share-stat-label">课程</span>
        </div>
      </div>

      <div style="font-size:11.5px;color:var(--text-muted);margin-top:10px;text-align:center">
        上次备份：<b style="color:${lastBackup && Date.now() - lastBackup < 7 * 86400000 ? 'var(--success)' : 'var(--warning)'}">${lastBackupText}</b>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
        <button class="btn btn-primary" data-action="data-export" data-module="all" type="button">📤 导出我的数据</button>
        <button class="btn" data-action="copy-app-info" type="button">📋 复制应用信息</button>
      </div>
    </div>`;
}

export function renderData() {
  const uid = State.user?.id;
  const stats = {
    diaries: DB.diaries.filter(x => x.user_id === uid).length,
    todos:   DB.todos.filter(x => x.user_id === uid).length,
    moods:   DB.moods.filter(x => x.user_id === uid).length,
    metrics: DB.metrics.filter(x => x.user_id === uid).length,
    goals:   DB.goals.filter(x => x.user_id === uid).length,
    habits:  DB.habits.filter(x => x.user_id === uid).length,
    courses: DB.courses.filter(x => x.user_id === uid).length,
    health:  (DB.healthRecords || []).filter(x => x.user_id === uid).length,
    review:  (DB.cards || []).filter(x => x.user_id === uid).length
  };
  const total = Object.values(stats).reduce((a, b) => a + b, 0);

  let autoBackupText = '暂无自动备份';
  let autoBackupAvailable = false;
  try {
    const info = getAutoBackupInfo();
    if (info && info.at) {
      const ago = Math.floor((Date.now() - new Date(info.at).getTime()) / 60000);
      const agoText = ago < 1 ? '刚刚' : ago < 60 ? `${ago} 分钟前` : ago < 1440 ? `${Math.floor(ago / 60)} 小时前` : `${Math.floor(ago / 1440)} 天前`;
      autoBackupText = `${new Date(info.at).toLocaleString('zh-CN')}（${agoText}）`;
      autoBackupAvailable = true;
    }
  } catch (e) {}

  return `
    <div class="panel">
      <div class="panel-title"><span class="title-icon">📦</span>数据</div>
      <div class="stat-grid">
        <div class="stat-item"><span class="stat-num">${stats.diaries}</span><span class="stat-name">随笔</span></div>
        <div class="stat-item"><span class="stat-num">${stats.todos}</span><span class="stat-name">待办</span></div>
        <div class="stat-item"><span class="stat-num">${stats.moods}</span><span class="stat-name">心情</span></div>
        <div class="stat-item"><span class="stat-num">${stats.metrics}</span><span class="stat-name">指标</span></div>
        <div class="stat-item"><span class="stat-num">${stats.goals}</span><span class="stat-name">目标</span></div>
        <div class="stat-item"><span class="stat-num">${stats.habits}</span><span class="stat-name">习惯</span></div>
        <div class="stat-item"><span class="stat-num">${stats.courses}</span><span class="stat-name">课程</span></div>
        <div class="stat-item"><span class="stat-num">${stats.health}</span><span class="stat-name">健康</span></div>
        <div class="stat-item"><span class="stat-num">${stats.review}</span><span class="stat-name">卡片</span></div>
        <div class="stat-item highlight"><span class="stat-num">${total}</span><span class="stat-name">总计</span></div>
      </div>

      <div style="font-size:12.5px;color:var(--text-sec);margin:18px 0 8px;font-weight:700">📤 分模块导出</div>
      <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:10px;line-height:1.5">
        分模块导出便于分享部分数据。朋友导入后只拿到对应模块的内容。
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        <button class="btn btn-primary btn-sm" data-action="data-export" data-module="all" type="button">📦 全部</button>
        <button class="btn btn-sm" data-action="data-export" data-module="health" type="button">💚 健康</button>
        <button class="btn btn-sm" data-action="data-export" data-module="review" type="button">📚 复习</button>
        <button class="btn btn-sm" data-action="data-export" data-module="diary" type="button">📝 日记</button>
        <button class="btn btn-sm" data-action="data-export" data-module="habitgoal" type="button">🔥 习惯目标</button>
        <button class="btn btn-sm" data-action="data-export" data-module="calsch" type="button">📅 课表</button>
        <button class="btn btn-sm" data-action="data-export" data-module="metrics" type="button">📊 指标</button>
      </div>

      <div style="font-size:12.5px;color:var(--text-sec);margin:18px 0 8px;font-weight:700">📥 导入 / 恢复</div>
      <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:10px;line-height:1.5">
        导入前会自动备份当前数据（防止操作失误）。导入时先预览再确认。
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <button class="btn btn-sm" data-action="data-import" type="button">📥 导入文件</button>
        <input type="file" id="importFile" accept=".json" style="display:none">
        <button class="btn btn-sm${autoBackupAvailable ? '' : ' btn-ghost'}" data-action="data-restore-auto" type="button" ${autoBackupAvailable ? '' : 'disabled'}>♻️ 恢复自动备份</button>
      </div>
      <div style="font-size:11px;color:var(--text-muted);padding:8px 12px;background:var(--bg-input);border-radius:8px;border-left:3px solid var(--info)">
        ♻️ 最近自动备份：<b style="color:var(--text)">${autoBackupText}</b>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:18px;padding-top:14px;border-top:1px dashed var(--border)">
        <button class="btn btn-danger btn-sm" data-action="data-clear" type="button">🗑️ 清空全部</button>
      </div>
    </div>`;
}

export function renderAbout() {
  return `
    <div class="panel">
      <div class="panel-title"><span class="title-icon">ℹ️</span>关于</div>
      <div style="font-size:12.5px;color:var(--text-sec);line-height:2">
        <div><b style="color:var(--text)">仙小助</b> · 生涯规划与自我提升助手</div>
        <div>当前版本：<b style="color:var(--accent);font-family:var(--mono)">v${APP_VERSION}</b></div>
        <div>构建日期：<span style="font-family:var(--mono)">${BUILD_DATE}</span></div>
        <div>数据格式：<span style="font-family:var(--mono)">v${SCHEMA_VERSION}</span></div>
        <div style="margin-top:8px;color:var(--text-muted);font-size:11.5px">
          完全本地运行 · 数据自主可控
        </div>
      </div>
    </div>`;
}