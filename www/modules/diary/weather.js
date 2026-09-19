import { DB, State, save, S } from '../../core/db.js';
import { esc, fmtD, addDays, WMO, WEATHER_TXT_TO_WMO } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';

const CACHE_KEY = 'weather_cache_v20';
const CACHE_TIME_KEY = 'weather_cache_time_v20';
const CACHE_DURATION = 30 * 60 * 1000;

function isAIEnabled() {
  const c = State.aiConfig;
  return !!(c && c.enabled && c.apiKey && c.endpoint);
}

function aiURL() {
  let ep = String(State.aiConfig.endpoint || '').trim().replace(/\/+$/, '');
  if (ep && !/\/chat\/completions$/.test(ep)) ep += '/chat/completions';
  return ep;
}

function geoCacheGet(city) {
  const all = S.get('geo_cache', {});
  const c = all[String(city).trim()];
  if (!c) return null;
  if (State.amapKey && !c.adcode) return null;
  if (c.lat == null && c.lon == null && !c.adcode) return null;
  return c;
}

function geoCacheSet(city, loc) {
  if (!loc) return;
  const all = S.get('geo_cache', {});
  const prev = all[String(city).trim()] || {};
  all[String(city).trim()] = {
    name: loc.name || prev.name || city,
    admin1: loc.admin1 != null ? loc.admin1 : (prev.admin1 || ''),
    adcode: loc.adcode || prev.adcode || '',
    lat: loc.lat != null ? loc.lat : prev.lat,
    lon: loc.lon != null ? loc.lon : prev.lon,
    _src: loc._src || prev._src || '',
    ts: Date.now()
  };
  S.set('geo_cache', all);
}

async function geoViaAI(city) {
  if (!isAIEnabled()) return null;
  try {
    const prompt = `请给出中国城市"${city}"的信息，只返回严格 JSON：\n{"name":"规范名","admin1":"省/直辖市","adcode":"6位数字","lat":纬度数字,"lon":经度数字}`;
    const res = await fetch(aiURL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + State.aiConfig.apiKey },
      body: JSON.stringify({
        model: State.aiConfig.model || 'deepseek-flash',
        messages: [
          { role: 'system', content: '你是地理信息助手，只输出严格合法的 JSON。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1
      })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('空响应');
    let s = String(content).replace(/```json|```/g, '').trim();
    let obj;
    try { obj = JSON.parse(s); }
    catch { const m = s.match(/\{[\s\S]*\}/); if (m) obj = JSON.parse(m[0]); else throw new Error('解析失败'); }
    const lat = parseFloat(obj.lat), lon = parseFloat(obj.lon);
    const adcode = String(obj.adcode || '').replace(/\D/g, '').slice(0, 6);
    const hasLat = !isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    const hasAd = /^\d{6}$/.test(adcode);
    if (!hasLat && !hasAd) throw new Error('AI 返回不合法');
    return {
      name: String(obj.name || city).trim(),
      admin1: String(obj.admin1 || '').trim(),
      adcode: hasAd ? adcode : '',
      lat: hasLat ? lat : null,
      lon: hasLat ? lon : null,
      _src: 'ai'
    };
  } catch (e) {
    console.warn('AI 地理编码失败：', e);
    return null;
  }
}

async function geoViaOpenMeteo(city) {
  try {
    const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=5&language=zh&format=json`);
    const gd = await geo.json();
    if (!gd.results || !gd.results.length) return null;
    const cn = gd.results.find(r => r.country_code === 'CN' || r.country === '中国') || gd.results[0];
    return { name: cn.name, admin1: cn.admin1 || '', adcode: '', lat: cn.latitude, lon: cn.longitude, _src: 'open-meteo' };
  } catch { return null; }
}

async function fetchAmapWeather(adcode) {
  const key = State.amapKey;
  if (!key || !adcode) throw new Error('缺少高德 Key 或 adcode');
  const url = `https://restapi.amap.com/v3/weather/weatherInfo?key=${encodeURIComponent(key)}&city=${encodeURIComponent(adcode)}&extensions=all`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('高德 HTTP ' + res.status);
  const data = await res.json();
  if (data.status !== '1') throw new Error(data.info || '高德失败');
  const fc = data.forecasts && data.forecasts[0];
  if (!fc || !fc.casts || !fc.casts.length) throw new Error('无预报数据');
  const today0 = fc.casts[0];
  let live = null;
  try {
    const r2 = await fetch(`https://restapi.amap.com/v3/weather/weatherInfo?key=${encodeURIComponent(key)}&city=${encodeURIComponent(adcode)}&extensions=base`);
    const d2 = await r2.json();
    if (d2.status === '1' && d2.lives && d2.lives[0]) live = d2.lives[0];
  } catch {}
  const temp = parseInt(live ? live.temperature : today0.daytemp, 10);
  const dayTxt = live ? live.weather : today0.dayweather;
  const humidity = live && live.humidity ? parseInt(live.humidity, 10) : 60;
  const power = (live ? live.windpower : today0.daypower) || '';
  const pnum = parseInt(String(power).replace(/\D/g, ''), 10);
  const windSpeed = isNaN(pnum) ? 10 : Math.round(pnum * 5.5 + 2);
  const forecast = fc.casts.slice(0, 3).map(c => ({
    date: c.date,
    code: WEATHER_TXT_TO_WMO(c.dayweather),
    max: parseInt(c.daytemp, 10) || temp + 3,
    min: parseInt(c.nighttemp, 10) || temp - 3,
    uv: 0, sunrise: ''
  }));
  return {
    city: fc.city || '',
    admin1: fc.province || '',
    temp: isNaN(temp) ? 25 : temp,
    feels: isNaN(temp) ? 25 : temp,
    humidity: isNaN(humidity) ? 60 : humidity,
    windSpeed,
    uvIndex: 0,
    code: WEATHER_TXT_TO_WMO(dayTxt),
    forecast,
    updatedAt: new Date().toISOString(),
    _source: 'amap'
  };
}

async function fetchOpenMeteoWeather(lat, lon, cityName) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,uv_index&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=3`;
  const r = await fetch(url);
  const d = await r.json();
  const c = d.current, day = d.daily;
  const forecast = [];
  for (let i = 0; i < 3; i++) forecast.push({
    date: day.time[i], code: day.weather_code[i],
    max: day.temperature_2m_max[i], min: day.temperature_2m_min[i], uv: 0, sunrise: ''
  });
  return {
    city: cityName, admin1: '',
    temp: Math.round(c.temperature_2m),
    feels: Math.round(c.apparent_temperature),
    humidity: c.relative_humidity_2m,
    windSpeed: Math.round(c.wind_speed_10m),
    uvIndex: c.uv_index,
    code: c.weather_code,
    forecast,
    updatedAt: new Date().toISOString(),
    _source: 'open-meteo'
  };
}

// ⭐ 关键：只刷新天气卡片，不再整体 rerender
function refreshCard() {
  const el = document.getElementById('weatherCardContainer');
  if (el) el.innerHTML = renderMiniCard();
  const top = document.getElementById('weatherTopHost');
  if (top) top.innerHTML = State.weather ? renderWeatherTop() : '';
}

export function renderWeatherTop() {
  const w = State.weather;
  if (!w) return '';
  return `<button class="nav-weather" data-action="weather-refresh" type="button">
    <span class="wi">${w.icon || '🌤️'}</span>
    <span class="temp">${w.temp}°</span>
    <span class="city">${esc(w.city)}</span>
  </button>`;
}

export async function load(force = false) {
  if (State.weatherLoading) return;
  const city = (State.user && State.user.city) || '北京';
  const cached = S.get(CACHE_KEY, null);
  const ct = S.get(CACHE_TIME_KEY, 0);

  if (!force && cached && cached.city === city && Date.now() - ct < CACHE_DURATION) {
    State.weather = cached;
    State.weatherError = null;
    refreshCard();     // ⭐ 只刷卡片
    return;
  }

  State.weatherLoading = true;
  State.weatherError = null;
  State.weather = null;
  refreshCard();

  try {
    let loc = null;
    const u = State.user;
    if (u && u.weatherLat != null && u.weatherLon != null && u.weatherLat !== '' && u.weatherLon !== '') {
      const lat = parseFloat(u.weatherLat), lon = parseFloat(u.weatherLon);
      if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        loc = { name: city, admin1: '', adcode: u.weatherAdcode || '', lat, lon, _src: 'manual' };
      }
    }
    if (!loc) loc = geoCacheGet(city);
    if (!loc) { loc = await geoViaAI(city); if (loc) geoCacheSet(city, loc); }
    if (!loc) { loc = await geoViaOpenMeteo(city); if (loc) geoCacheSet(city, loc); }
    if (!loc) throw new Error(`未找到「${city}」的坐标`);

    let weather = null;
    let lastErr = null;
    if (loc.adcode && State.amapKey) {
      try { weather = await fetchAmapWeather(loc.adcode); }
      catch (e) { lastErr = e; }
    }
    if (!weather && loc.lat != null && loc.lon != null) {
      try { weather = await fetchOpenMeteoWeather(loc.lat, loc.lon, loc.name); }
      catch (e) { lastErr = e; }
    }
    if (!weather) throw lastErr || new Error('无可用天气源');

    weather.icon = (WMO[weather.code] || WMO[3]).icon;
    weather.desc = (WMO[weather.code] || WMO[3]).desc;
    weather._geo = loc._src;
    State.weather = weather;
    S.set(CACHE_KEY, weather);
    S.set(CACHE_TIME_KEY, Date.now());
  } catch (err) {
    State.weatherError = err.message || '天气获取失败';
    State.weather = null;
  } finally {
    State.weatherLoading = false;
    refreshCard();     // ⭐ 只刷卡片
  }
}

export function renderMiniCard() {
  if (State.weatherLoading && !State.weather) {
    return `<div class="weather-card"><div style="text-align:center;padding:30px;color:var(--text-muted);font-size:12px">正在获取天气...</div></div>`;
  }
  if (!State.weather) {
    const city = (State.user && State.user.city) || '未设置';
    return `<div class="weather-card">
      <div class="weather-head"><span class="weather-loc">📍 ${esc(city)}</span><button class="weather-refresh" data-action="weather-refresh" type="button">🔄</button></div>
      <div style="text-align:center;padding:20px;color:var(--text-muted);font-size:12px;line-height:1.7">${esc(State.weatherError || '暂无天气')}</div>
    </div>`;
  }
  const w = State.weather;
  const srcTag = w._source === 'amap'
    ? ' <span style="font-size:9px;padding:1px 6px;border-radius:6px;background:rgba(74,222,128,.18);color:var(--success);font-weight:800;margin-left:4px">气象局</span>'
    : (w._source === 'open-meteo' ? ' <span style="font-size:9px;padding:1px 6px;border-radius:6px;background:var(--bg-input);color:var(--text-muted);font-weight:800;margin-left:4px">OM</span>' : '');
  const fore = w.forecast.slice(0, 3).map((f, i) => {
    const n = i === 0 ? '今天' : i === 1 ? '明天' : '后天';
    const ic = (WMO[f.code] || WMO[3]).icon;
    return `<div><div class="fd-name">${n}</div><div style="font-size:18px;line-height:1">${ic}</div><div class="fd-temp">${Math.round(f.min)}~${Math.round(f.max)}°</div></div>`;
  }).join('');

  return `<div class="weather-card">
    <div class="weather-head">
      <span class="weather-loc">📍 ${esc(w.city)}${w.admin1 ? ' · ' + esc(w.admin1) : ''}${srcTag}</span>
      <button class="weather-refresh" data-action="weather-refresh" type="button">🔄</button>
    </div>
    <div class="weather-main">
      <div class="weather-icon">${w.icon || '🌤️'}</div>
      <div>
        <div class="weather-temp">${w.temp}<span class="unit">°C</span></div>
        <div class="weather-desc">${w.desc || ''} · 体感 ${w.feels}°</div>
      </div>
    </div>
    <div class="weather-mini-grid">
      <div><span>💧</span>${w.humidity}%</div>
      <div><span>💨</span>${w.windSpeed}</div>
      <div><span>☀️</span>${w.uvIndex != null ? Math.round(w.uvIndex) : '--'}</div>
    </div>
    <div class="weather-forecast-compact">${fore}</div>
  </div>`;
}

export const actions = {
  'weather-refresh': () => load(true)
};