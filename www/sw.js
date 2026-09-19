/* 仙小助 Service Worker
 * 作用：缓存所有本地静态资源，让应用能离线打开（PWA）
 * 只在 http:// 或 https:// 下工作；file:// 协议下浏览器不会注册 SW
 */

const CACHE_VERSION = 'v2';
const CACHE_NAME = 'xianxiaozhu-' + CACHE_VERSION;

/* 预缓存的核心资源列表 */
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon.svg',
  './app.js',
  './core/db.js',
  './core/bus.js',
  './core/registry.js',
  './core/utils.js',
  './core/theme.js',
  './core/theme.css',
  './ui/shell.js',
  './ui/modal.js',
  './ui/toast.js',
  './modules/auth/index.js',
  './modules/auth/style.css',
  './modules/diary/index.js',
  './modules/diary/style.css',
  './modules/diary/write.js',
  './modules/diary/mood.js',
  './modules/diary/todo.js',
  './modules/diary/ai.js',
  './modules/diary/weather.js',
  './modules/diary/metric.js',
  './modules/calsch/index.js',
  './modules/calsch/style.css',
  './modules/calsch/calendar.js',
  './modules/calsch/schedule.js',
  './modules/calsch/importer.js',
  './modules/habitgoal/index.js',
  './modules/habitgoal/style.css',
  './modules/habitgoal/habit.js',
  './modules/habitgoal/goal.js',
  './modules/habitgoal/badge.js',
  './modules/health/index.js',
  './modules/health/style.css',
  './modules/timer/index.js',
  './modules/timer/style.css',
  './modules/timer/pomo.js',
  './modules/timer/custom.js',
  './modules/summary/index.js',
  './modules/summary/style.css',
  './modules/summary/charts.js',
  './modules/settings/index.js',
  './modules/settings/style.css',
  './modules/settings/sections.js',
  './modules/onboarding/index.js',
  './modules/onboarding/style.css',
  './modules/review/index.js',
  './modules/review/style.css',
  './modules/review/deck.js',
  './modules/review/card.js',
  './modules/review/reviewer.js',
  './modules/review/ai.js',
  './modules/review/importer.js',
  './modules/review/dictation.js',
  './modules/review/quiz.js',
  './modules/review/errorbook.js',
  './modules/review/stats.js',
  './modules/review/curve.js',
  './modules/review/algorithm.js'
];

/* ============ install：预缓存 ============ */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      const results = await Promise.allSettled(
        CORE_ASSETS.map(url => cache.add(url).catch(err => {
          console.warn('[SW] 缓存失败:', url, err.message);
        }))
      );
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed) console.warn(`[SW] ${failed} 个资源缓存失败`);
      return self.skipWaiting();
    })
  );
});

/* ============ activate：清旧缓存 ============ */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('xianxiaozhu-') && k !== CACHE_NAME)
          .map(k => {
            console.log('[SW] 删除旧缓存:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

/* ============ fetch：分流策略 ============ */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* 跨域请求（外部 API：天气、AI 等）走网络，不缓存 */
  if (url.origin !== self.location.origin) {
    return;
  }

  /* HTML 文档 → 网络优先，失败回退缓存 */
  if (req.destination === 'document' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  /* manifest.json → 网络优先 */
  if (url.pathname.endsWith('manifest.json')) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }

  /* 其他静态资源 → 缓存优先 */
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => {
        if (req.destination === 'image') {
          return new Response('', { status: 404 });
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      });
    })
  );
});

/* ============ message：允许页面主动要求更新 ============ */
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => {
      event.source.postMessage({ type: 'CACHE_CLEARED' });
    });
  }
});