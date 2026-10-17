const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_NAME = 'MeReader-Lite';
const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');

const DEFAULT_SETTINGS = {
  theme: 'light',
  fontFamily: 'system-ui',
  fontSize: 16,
  lineHeight: 1.8,
  viewMode: 'preview',
  zoom: 1,
  recentFiles: []
};

const FONT_OPTIONS = [
  ['system-ui', '系统默认'],
  ['"Microsoft YaHei UI", "Microsoft YaHei", sans-serif', '微软雅黑'],
  ['SimSun, "Songti SC", serif', '宋体'],
  ['KaiTi, serif', '楷体'],
  ['"Times New Roman", serif', 'Times New Roman'],
  ['Consolas, "Courier New", monospace', '等宽字体']
];

const THEME_OPTIONS = [
  ['light', '浅色'],
  ['dark', '深色'],
  ['eye', '护眼'],
  ['sepia', '羊皮纸']
];

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const autosaveFile = () => path.join(app.getPath('userData'), 'autosave.json');

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

let settings = { ...DEFAULT_SETTINGS };
let win = null;
let forceClose = false;

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = { ...DEFAULT_SETTINGS, ...raw, recentFiles: Array.isArray(raw.recentFiles) ? raw.recentFiles : [] };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('saveSettings failed:', err);
  }
}

function readAutosave() {
  try {
    const data = JSON.parse(fs.readFileSync(autosaveFile(), 'utf8'));
    if (Array.isArray(data.docs) && data.docs.length > 0) return data;
  } catch {}
  return null;
}

function writeAutosave(data) {
  try {
    fs.mkdirSync(path.dirname(autosaveFile()), { recursive: true });
    fs.writeFileSync(autosaveFile(), JSON.stringify(data), 'utf8');
  } catch {}
}

function clearAutosave() {
  try {
    fs.rmSync(autosaveFile(), { force: true });
  } catch {}
}

function addRecent(filePath) {
  settings.recentFiles = [filePath, ...settings.recentFiles.filter((f) => f !== filePath)].slice(0, 8);
  saveSettings();
  buildMenu();
}

function applyZoom() {
  if (win) win.webContents.setZoomFactor(settings.zoom);
}

function sendToWindow(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function updateWindowThemeBg() {
  if (!win) return;
  const bg = { light: '#ffffff', dark: '#1e1e1e', eye: '#c7edcc', sepia: '#f4ecd8' }[settings.theme] || '#ffffff';
  win.setBackgroundColor(bg);
}

function initialFileArg() {
  const args = process.argv.slice(1).filter((a) => !a.startsWith('-'));
  for (const a of args) {
    if (/\.(md|markdown|txt|mdown|mkd)$/i.test(a) && fs.existsSync(a)) return path.resolve(a);
  }
  return null;
}

function openPathFromMain(filePath) {
  sendToWindow('file:open-path', filePath);
}

function buildMenu() {
  const send = (action, payload) => sendToWindow('menu:action', { action, payload });

  const recentSubmenu = settings.recentFiles.length
    ? settings.recentFiles.map((f) => ({
        label: path.basename(f),
        toolTip: f,
        click: () => openPathFromMain(f)
      }))
    : [{ label: '（无）', enabled: false }];

  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建标签页', accelerator: 'CmdOrCtrl+T', click: () => send('new-tab') },
        { label: '打开...', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: '另存为...', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('saveAs') },
        { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', click: () => send('close-tab') },
        { type: 'separator' },
        { label: '打开所在文件夹', click: () => send('reveal') },
        { label: '最近文件', submenu: recentSubmenu },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '预览模式', accelerator: 'CmdOrCtrl+1', click: () => send('mode', 'preview') },
        { label: '分屏模式', accelerator: 'CmdOrCtrl+2', click: () => send('mode', 'split') },
        { label: '编辑模式', accelerator: 'CmdOrCtrl+3', click: () => send('mode', 'edit') },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: () => changeZoom(0.1) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => changeZoom(-0.1) },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: () => setZoom(1) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '设置',
      submenu: [
        {
          label: '主题配色',
          submenu: THEME_OPTIONS.map(([id, label]) => ({
            label,
            type: 'radio',
            checked: settings.theme === id,
            click: () => updateSettings({ theme: id })
          }))
        },
        {
          label: '字体',
          submenu: FONT_OPTIONS.map(([id, label]) => ({
            label,
            type: 'radio',
            checked: settings.fontFamily === id,
            click: () => updateSettings({ fontFamily: id })
          }))
        },
        {
          label: '字号',
          submenu: [12, 14, 16, 18, 20, 24, 28].map((size) => ({
            label: `${size} px`,
            type: 'radio',
            checked: settings.fontSize === size,
            click: () => updateSettings({ fontSize: size })
          }))
        },
        {
          label: '行距',
          submenu: [1.4, 1.6, 1.8, 2.0, 2.2].map((v) => ({
            label: `${v} 倍`,
            type: 'radio',
            checked: settings.lineHeight === v,
            click: () => updateSettings({ lineHeight: v })
          }))
        }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于 MeReader-Lite', click: () => showAbout() },
        { label: 'Markdown 语法参考', click: () => shell.openExternal('https://www.markdownguide.org/basic-syntax/') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function updateSettings(patch) {
  settings = { ...settings, ...patch };
  saveSettings();
  if (patch.zoom !== undefined) applyZoom();
  if (patch.theme !== undefined) updateWindowThemeBg();
  buildMenu();
  sendToWindow('settings:changed', settings);
}

function changeZoom(delta) {
  setZoom(Math.round((settings.zoom + delta) * 10) / 10);
}

function setZoom(zoom) {
  updateSettings({ zoom: Math.min(3, Math.max(0.5, zoom)) });
}

function showAbout() {
  dialog.showMessageBox(win, {
    type: 'info',
    title: '关于',
    message: `${APP_NAME} v${app.getVersion()}`,
    detail: `轻量级 Markdown 阅读器与编辑器\n\n版权所有：啊坤\n联系邮箱：akun666yyds@gmail.com`,
    buttons: ['确定']
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 640,
    minHeight: 420,
    icon: ICON_PATH,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  updateWindowThemeBg();
  win.once('ready-to-show', () => {
    win.show();
    applyZoom();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (forceClose) return;
    e.preventDefault();
    sendToWindow('window:before-close');
  });
  win.on('closed', () => {
    win = null;
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

ipcMain.handle('app:get-state', () => ({
  settings,
  version: app.getVersion(),
  initialFile: initialFileArg(),
  recovery: readAutosave()
}));

ipcMain.handle('file:read', (_e, filePath) => {
  let content = fs.readFileSync(filePath, 'utf8');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  addRecent(filePath);
  return { content: content.replace(/\r\n/g, '\n') };
});

ipcMain.handle('file:open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '打开文件',
    filters: [
      { name: 'Markdown 文件', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('file:save-dialog', async (_e, defaultName) => {
  const r = await dialog.showSaveDialog(win, {
    title: '保存文件',
    defaultPath: defaultName || '未命名.md',
    filters: [{ name: 'Markdown 文件', extensions: ['md'] }]
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('file:write', (_e, { filePath, content }) => {
  fs.writeFileSync(filePath, content.replace(/\n/g, '\r\n'), 'utf8');
  addRecent(filePath);
  return true;
});

ipcMain.handle('dialog:confirm-close', async (_e, name) => {
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    title: '未保存的更改',
    message: `是否要将对「${name}」的更改保存？`,
    detail: '如果您不保存，关闭后将丢失这些更改。',
    buttons: ['保存', '不保存', '取消'],
    defaultId: 0,
    cancelId: 2
  });
  return ['save', 'discard', 'cancel'][r.response];
});

ipcMain.handle('dialog:confirm-close-multi', async (_e, names) => {
  const listed = names.slice(0, 6).join('、') + (names.length > 6 ? ' 等' : '');
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    title: '未保存的更改',
    message: `有 ${names.length} 个标签页尚未保存：\n${listed}\n\n是否全部保存？`,
    detail: '如果您不保存，关闭后将丢失这些更改。',
    buttons: ['全部保存', '全部不保存', '取消'],
    defaultId: 0,
    cancelId: 2
  });
  return ['saveAll', 'discardAll', 'cancel'][r.response];
});

ipcMain.handle('file:rename', (_e, { filePath, newName }) => {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  let target = path.join(dir, newName.trim());
  if (!/\.(md|markdown|txt|mdown|mkd)$/i.test(target)) target += ext || '.md';
  if (target !== filePath && fs.existsSync(target)) {
    const err = new Error(`同名文件已存在：${target}`);
    throw err;
  }
  fs.renameSync(filePath, target);
  settings.recentFiles = settings.recentFiles.map((f) => (samePath(f, filePath) ? target : f));
  saveSettings();
  buildMenu();
  return target;
});

ipcMain.handle('dialog:confirm', async (_e, opts) => {
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: opts.buttons || ['确定', '取消'],
    defaultId: 0,
    cancelId: opts.buttons ? opts.buttons.length - 1 : 1,
    title: opts.title || APP_NAME,
    message: opts.message
  });
  return r.response;
});

ipcMain.on('autosave:write', (_e, data) => writeAutosave(data));
ipcMain.on('autosave:clear', () => clearAutosave());
ipcMain.on('window:force-close', () => {
  forceClose = true;
  if (win) win.close();
});
ipcMain.handle('settings:set', (_e, patch) => {
  updateSettings(patch);
  return settings;
});
ipcMain.handle('file:reveal', (_e, filePath) => {
  if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    const args = argv.slice(1).filter((a) => !a.startsWith('-'));
    for (const a of args) {
      if (/\.(md|markdown|txt|mdown|mkd)$/i.test(a) && fs.existsSync(a)) {
        openPathFromMain(path.resolve(a));
        break;
      }
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.akun.mereader-lite');
    loadSettings();
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  app.quit();
});
