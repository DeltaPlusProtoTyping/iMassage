// Throwaway recorder: renders tutorial.html offscreen and lets it write the video (or stills).
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const page = path.join(__dirname, '..', 'tutorial.html');
const still = (process.argv.find(a => a.startsWith('--still=')) || '').slice(8);

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1920, height: 1080, show: false, useContentSize: true,
    webPreferences: { offscreen: true, nodeIntegration: true, contextIsolation: false, sandbox: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  win.webContents.setFrameRate(60);
  win.webContents.on('console-message', (_e, _l, msg) => console.log('page:', msg));
  win.webContents.on('render-process-gone', (_e, d) => { console.log('gone', d.reason); app.exit(1); });
  ipcMain.on('done', (_e, what) => { console.log('done', what); app.quit(); });
  win.loadFile(page, { search: still ? `still=${still}` : 'record=1' });
});
