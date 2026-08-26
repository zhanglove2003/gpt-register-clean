const path = require('path');
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');

const projectRoot = path.resolve(__dirname, '..');
const outDir = process.argv[2] || path.join(projectRoot, 'desktop-release', 'visual-qa');

async function capture(win, name) {
  await new Promise(resolve => setTimeout(resolve, 800));
  const image = await win.capturePage();
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, `${name}.png`), image.toPNG());
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: true,
    backgroundColor: '#eef7f4',
    webPreferences: {
      preload: path.join(__dirname, 'visual-qa-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  await win.webContents.executeJavaScript(`new Promise(resolve => { const wait = () => window.__desktopBootDone ? resolve() : setTimeout(wait, 50); wait(); })`);
  await capture(win, 'console');
  await win.webContents.executeJavaScript(`window.__setDesktopView('config')`);
  await capture(win, 'config');
  await win.webContents.executeJavaScript(`window.__setDesktopView('herosms'); document.querySelector('#refreshHeroBtn').click()`);
  await capture(win, 'herosms');
  app.quit();
});

