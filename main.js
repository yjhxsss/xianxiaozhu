const { app, BrowserWindow, protocol, shell } = require('electron');
const path = require('path');
const fs = require('fs');

/* ============ 单实例锁：避免多开导致 localStorage 写入冲突 ============ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  main();
}

function main() {

  /* ============ 协议注册：必须在 app.whenReady() 之前 ============ */
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true
      }
    }
  ]);

  const ROOT = app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'www')
    : path.join(__dirname, 'www');

  const ROOT_REAL = fs.realpathSync(ROOT);

  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.mjs':  'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.ttf':  'font/ttf',
    '.txt':  'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8'
  };

  /* ============ 窗口状态持久化 ============ */
  const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

  function loadWindowState() {
    try {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const s = JSON.parse(raw);
      if (typeof s.width === 'number' && typeof s.height === 'number') return s;
    } catch {}
    return { width: 1280, height: 860, max: false };
  }

  function saveWindowState(win) {
    try {
      const b = win.getBounds();
      const max = win.isMaximized();
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        width: b.width, height: b.height, x: b.x, y: b.y, max
      }), 'utf-8');
    } catch {}
  }

  /* ============ 创建窗口 ============ */
  let win = null;

  function createWindow() {
    const st = loadWindowState();

    win = new BrowserWindow({
      width: st.width,
      height: st.height,
      x: st.x,
      y: st.y,
      title: '仙小助',
      backgroundColor: '#0b0d1a',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    });

    if (st.max) win.maximize();

    win.loadURL('app://local/index.html');
    win.setMenuBarVisibility(false);

    /* ⭐ 开发模式才开 DevTools */
    if (!app.isPackaged) {
      win.webContents.openDevTools();
    }

    /* ⭐ 阻止新窗口 / 外链跳系统浏览器 */
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    /* ⭐ 阻止应用内导航到非 app:// */
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('app://')) {
        e.preventDefault();
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      }
    });

    /* 窗口大小变化时保存状态（防抖） */
    let saveTimer = null;
    const scheduleSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { if (win && !win.isDestroyed()) saveWindowState(win); }, 400);
    };
    win.on('resize', scheduleSave);
    win.on('move', scheduleSave);
    win.on('maximize', scheduleSave);
    win.on('unmaximize', scheduleSave);

    win.on('closed', () => { win = null; });
  }

  /* ============ app.whenReady ============ */
  app.whenReady().then(() => {

    /* 协议 handler：映射 app://local/xxx → ROOT/xxx */
    protocol.handle('app', (req) => {
      try {
        const url = new URL(req.url);
        let rel = decodeURIComponent(url.pathname);
        if (rel === '/' || rel === '') rel = '/index.html';

        const filePath = path.normalize(path.join(ROOT, rel));

        /* 基本越界检查 */
        if (!filePath.startsWith(ROOT)) {
          return new Response('Forbidden', { status: 403 });
        }

        /* ⭐ 防符号链接：realpath 后仍要在 ROOT 内 */
        let realPath;
        try {
          realPath = fs.realpathSync(filePath);
        } catch {
          realPath = filePath;
        }
        if (!realPath.startsWith(ROOT_REAL)) {
          return new Response('Forbidden', { status: 403 });
        }

        /* 文件不存在 */
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          /* ⭐ 无扩展名 → 回退 index.html（SPA 场景） */
          const ext = path.extname(filePath).toLowerCase();
          if (!ext) {
            const fallback = path.join(ROOT, 'index.html');
            if (fs.existsSync(fallback)) {
              const data = fs.readFileSync(fallback);
              return new Response(new Uint8Array(data), {
                status: 200,
                headers: { 'Content-Type': MIME['.html'] }
              });
            }
          }
          return new Response('Not found: ' + rel, {
            status: 404,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }

        const ext = path.extname(filePath).toLowerCase();
        const mime = MIME[ext] || 'application/octet-stream';
        const data = fs.readFileSync(filePath);

        return new Response(new Uint8Array(data), {
          status: 200,
          headers: { 'Content-Type': mime }
        });
      } catch (err) {
        console.error('[app://] 处理异常:', err);
        return new Response('Server error: ' + err.message, { status: 500 });
      }
    });

    createWindow();

    /* macOS：点击 dock 图标重新激活 */
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  /* ⭐ 第二实例启动时，聚焦已有窗口 */
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  /* 关窗退出（macOS 除外） */
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}