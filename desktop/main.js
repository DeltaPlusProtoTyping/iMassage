'use strict';
// iMassage desktop shell. One window around the UI that server.py serves on 127.0.0.1, plus the
// pieces a browser tab can't do: lives in the tray when closed (so messages still notify), native
// toasts that open the right chat, a taskbar badge, the Windows emoji panel, start at login.
// Runs on the Electron runtime in ..\runtime (resources\app is a junction to this folder).

const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, ipcMain, shell, Notification, screen, clipboard, session } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const HERE = fs.realpathSync(__dirname);
const ROOT = path.dirname(HERE);
const CFG = readJson(path.join(ROOT, 'config.json')) || {};
const PORT = CFG.port || 8766;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const AUMID = 'Ben.iMassage';
const ICON = path.join(ROOT, 'iMassage.ico');

app.setName('iMassage');
app.setAppUserModelId(AUMID);

let win = null;
let tray = null;
let quitting = false;
let settings = { sounds: true, openAtLogin: true, theme: 'system', bounds: null };
const notes = new Set();  // live Notification objects; dropped ones can't be clicked

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (e) { console.error('settings', e); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fromUs = e => !!(e.senderFrame && e.senderFrame.url.startsWith(ORIGIN));

// ---------------------------------------------------------------- the Python server

function ping() {
  return new Promise(resolve => {
    const req = http.get(`${ORIGIN}/api/status`, { timeout: 1500 }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function findPythonw() {
  const dirs = (process.env.PATH || '').split(';').filter(Boolean);
  const candidates = [CFG.pythonw, 'C:\\Python314\\pythonw.exe', ...dirs.map(d => path.join(d, 'pythonw.exe'))];
  return candidates.find(p => p && fs.existsSync(p));
}

async function ensureServer() {
  if (await ping()) return true;
  const pythonw = findPythonw();
  if (pythonw) {
    spawn(pythonw, [path.join(ROOT, 'server.py')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await ping()) return true;
  }
  return false;
}

// ---------------------------------------------------------------- window

function overlay() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? '#121214' : '#ffffff', symbolColor: dark ? '#f5f5f7' : '#1d1d1f', height: 40 };
}

function visibleBounds(b) {
  if (!b || b.x == null) return {};
  const ok = screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 20 && b.y < a.y + a.height - 80;
  });
  return ok ? { x: b.x, y: b.y } : {};
}

let loadingOffline = false;
async function loadApp() {
  if (await ping()) {
    loadingOffline = false;
    return win.loadURL(`${ORIGIN}/`);
  }
  if (!loadingOffline) {
    loadingOffline = true;
    await win.loadFile(path.join(HERE, 'offline.html'));
  }
  await ensureServer();
  setTimeout(loadApp, 1500);
}

function createWindow(show) {
  const b = settings.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1180,
    height: b.height || 800,
    ...visibleBounds(b),
    minWidth: 380,
    minHeight: 460,
    show: false,
    title: 'iMassage',
    icon: ICON,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121214' : '#ffffff',
    titleBarStyle: 'hidden',
    titleBarOverlay: overlay(),
    webPreferences: {
      preload: path.join(HERE, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,  // keep the event stream live while hidden in the tray
      spellcheck: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  if (b.maximized) win.maximize();

  win.on('page-title-updated', e => e.preventDefault());
  win.once('ready-to-show', () => { if (show) win.show(); });
  win.on('close', e => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.on('focus', () => win.flashFrame(false));
  let saveTimer;
  const remember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMinimized()) return;
      settings.bounds = { ...(win.isMaximized() ? (settings.bounds || {}) : win.getBounds()), maximized: win.isMaximized() };
      saveSettings();
    }, 500);
  };
  win.on('resize', remember);
  win.on('move', remember);

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(ORIGIN)) shell.openExternal(url);
    else if (url.startsWith(ORIGIN)) wc.downloadURL(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (url.startsWith(ORIGIN) || url.startsWith('file:')) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  wc.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3 && url.startsWith(ORIGIN)) setTimeout(loadApp, 1500);
  });
  wc.on('render-process-gone', () => setTimeout(loadApp, 1000));
  wc.on('context-menu', (_e, p) => contextMenu(p));
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (ctrl && key === 'q') { e.preventDefault(); quitting = true; app.quit(); }
    else if (ctrl && key === 'w') { e.preventDefault(); win.hide(); }
    else if (ctrl && key === 'r') { e.preventDefault(); wc.reloadIgnoringCache(); }
    else if ((ctrl && input.shift && key === 'i') || key === 'f12') { e.preventDefault(); wc.toggleDevTools(); }
    else if (ctrl && (key === '=' || key === '+')) { e.preventDefault(); wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 4)); }
    else if (ctrl && key === '-') { e.preventDefault(); wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3)); }
    else if (ctrl && key === '0') { e.preventDefault(); wc.setZoomLevel(0); }
  });

  // Test hook: --capture=<png> [--chat=<id>] screenshots the window once the UI has loaded.
  const arg = name => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
  if (arg('capture')) {
    const onLoad = () => {
      if (!wc.getURL().startsWith(ORIGIN)) return;
      wc.off('did-finish-load', onLoad);
      setTimeout(async () => {
        try {
          if (arg('chat')) await wc.executeJavaScript(`openChat(${Number(arg('chat'))})`);
          if (arg('js')) await wc.executeJavaScript(arg('js'));
          if (arg('js-file')) { await wc.executeJavaScript(fs.readFileSync(arg('js-file'), 'utf8')); await new Promise(r => setTimeout(r, 1200)); }
        } catch (e) { fs.writeFileSync(`${arg('capture')}.err.txt`, String(e && e.stack || e)); }
        setTimeout(async () => {
          try {
            fs.writeFileSync(`${arg('capture')}.state.json`, JSON.stringify(await wc.executeJavaScript(
              '({current: S.current, booted: S.booted, chats: S.chats.size, empty: els.empty.hidden, toRow: els.toRow.hidden})')));
            fs.writeFileSync(arg('capture'), (await wc.capturePage()).toPNG());
          } catch (e) { fs.writeFileSync(`${arg('capture')}.err.txt`, String(e && e.stack || e)); }
          if (process.argv.includes('--capture-quit')) { quitting = true; app.quit(); }
        }, 3000);
      }, 2500);
    };
    wc.on('did-finish-load', onLoad);
  }
  loadApp();
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function contextMenu(p) {
  const items = [];
  const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }); };
  if (p.misspelledWord) {
    for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
    sep();
    items.push({ label: 'Add to Dictionary', click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
    sep();
  }
  if (p.linkURL && /^https?:\/\//i.test(p.linkURL) && !p.linkURL.startsWith(ORIGIN)) {
    items.push({ label: 'Open Link', click: () => shell.openExternal(p.linkURL) }, { label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) });
    sep();
  }
  if (p.mediaType === 'image' && p.srcURL.startsWith(ORIGIN)) {
    items.push({ label: 'Copy Image', click: () => win.webContents.copyImageAt(p.x, p.y) });
    if (p.srcURL.includes('/api/attachment/')) {
      items.push({ label: 'Save Image As…', click: () => win.webContents.downloadURL(`${p.srcURL.split('?')[0]}?download=1`) });
    }
    sep();
  }
  if (p.isEditable) {
    items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy },
      { role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' });
  } else if (p.selectionText && p.selectionText.trim()) {
    items.push({ role: 'copy' });
  }
  while (items.length && items[items.length - 1].type === 'separator') items.pop();
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
}

// ---------------------------------------------------------------- tray, login, shortcut

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open iMassage', click: showWindow },
    { label: 'New Message', click: () => { showWindow(); win.webContents.send('compose'); } },
    { type: 'separator' },
    {
      label: 'Sounds', type: 'checkbox', checked: settings.sounds,
      click: i => { settings.sounds = i.checked; saveSettings(); win.webContents.send('settings', { sounds: settings.sounds }); },
    },
    {
      label: 'Open at Login', type: 'checkbox', checked: settings.openAtLogin,
      click: i => { settings.openAtLogin = i.checked; saveSettings(); applyLogin(); },
    },
    {
      label: 'Appearance',
      submenu: [['system', 'Match Windows'], ['light', 'Light'], ['dark', 'Dark']].map(([value, label]) => ({
        label, type: 'radio', checked: settings.theme === value,
        click: () => { settings.theme = value; saveSettings(); nativeTheme.themeSource = value; },
      })),
    },
    { type: 'separator' },
    { label: 'Quit iMassage', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  tray = new Tray(ICON);
  tray.setToolTip('iMassage');
  tray.setContextMenu(trayMenu());
  tray.on('click', showWindow);
}

function applyLogin() {
  if (!app.isPackaged && !process.execPath.toLowerCase().endsWith('imassage.exe')) return;  // dev runs don't register
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, path: process.execPath, args: ['--hidden'] });
}

// Windows only shows toasts for apps with a Start Menu shortcut carrying their AppUserModelID.
function ensureShortcuts() {
  if (!process.execPath.toLowerCase().endsWith('imassage.exe')) return;
  const want = {
    target: process.execPath, args: '', cwd: path.dirname(process.execPath), appUserModelId: AUMID,
    icon: ICON, iconIndex: 0, description: 'iMessage on Windows, through your Mac',
  };
  const places = [
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'iMassage.lnk'),
    path.join(app.getPath('desktop'), 'iMassage.lnk'),
  ];
  for (const lnk of places) {
    let cur = null;
    try { cur = shell.readShortcutLink(lnk); } catch { /* missing */ }
    if (lnk.includes('Desktop') && !cur) continue;  // don't add a desktop icon nobody asked for
    if (!cur || cur.target !== want.target || cur.appUserModelId !== AUMID || cur.args) {
      shell.writeShortcutLink(lnk, cur ? 'replace' : 'create', want);
    }
  }
}

// ---------------------------------------------------------------- IPC from the page

function photoFile(url) {
  return new Promise(resolve => {
    if (!url || !url.startsWith(`${ORIGIN}/api/photo/`)) return resolve(ICON);
    const dir = path.join(app.getPath('userData'), 'photos');
    const file = path.join(dir, crypto.createHash('sha1').update(url).digest('hex') + '.jpg');
    if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 86400000) return resolve(file);
    fs.mkdirSync(dir, { recursive: true });
    http.get(url, { timeout: 4000 }, res => {
      if (res.statusCode !== 200) { res.resume(); return resolve(ICON); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { fs.writeFileSync(file, Buffer.concat(chunks)); resolve(file); } catch { resolve(ICON); } });
    }).on('error', () => resolve(ICON));
  });
}

function wireIpc() {
  ipcMain.on('badge', (e, count, dataUrl) => {
    if (!fromUs(e) || !win) return;
    win.setOverlayIcon(count && dataUrl ? nativeImage.createFromDataURL(dataUrl) : null, count ? `${count} unread` : '');
    if (tray) tray.setToolTip(count ? `iMassage: ${count} unread` : 'iMassage');
  });
  ipcMain.on('notify', async (e, n) => {
    if (!fromUs(e) || !Notification.isSupported() || !n) return;
    const note = new Notification({
      title: String(n.title || 'iMassage').slice(0, 120),
      body: String(n.body || '').slice(0, 300),
      icon: await photoFile(n.photo),
      silent: true,  // the window plays its own tri-tone, so it doesn't sound like every other Windows toast
    });
    note.on('click', () => { showWindow(); win.webContents.send('open-chat', n.chat); });
    note.on('close', () => notes.delete(note));
    notes.add(note);
    if (notes.size > 30) notes.delete(notes.values().next().value);
    note.show();
  });
  ipcMain.on('attention', e => { if (fromUs(e) && win && !win.isFocused()) win.flashFrame(true); });
  ipcMain.on('emoji', e => { if (fromUs(e)) app.showEmojiPanel(); });
  ipcMain.on('focus', e => { if (fromUs(e)) showWindow(); });
  ipcMain.handle('settings', () => ({ sounds: settings.sounds }));
}

// ---------------------------------------------------------------- start

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    showWindow();
    if (argv.includes('--new') && win) win.webContents.send('compose');
  });

  app.whenReady().then(() => {
    settings = { ...settings, ...(readJson(settingsPath()) || {}) };
    const themeArg = process.argv.find(a => a.startsWith('--theme='));
    nativeTheme.themeSource = themeArg ? themeArg.slice(8) : (settings.theme || 'system');
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => {
      cb(wc.getURL().startsWith(ORIGIN) && ['clipboard-sanitized-write', 'notifications', 'fullscreen'].includes(perm));
    });
    nativeTheme.on('updated', () => {
      if (!win) return;
      win.setTitleBarOverlay(overlay());
      win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#121214' : '#ffffff');
    });
    wireIpc();
    try { ensureShortcuts(); } catch (e) { console.error('shortcuts', e); }
    applyLogin();
    createTray();
    createWindow(!process.argv.includes('--hidden'));
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* stay in the tray */ });
}
