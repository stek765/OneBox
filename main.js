const { app, BrowserWindow, WebContentsView, Notification, Tray, ipcMain, shell, Menu, nativeTheme, nativeImage, globalShortcut, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { passes, inQuiet } = require('./filter');

// Default services, copied to services.json on first run. allow/deny are case-insensitive regexes tested on "title\nbody".
const DEFAULTS = [
  { id: 'whatsapp', name: 'WhatsApp', url: 'https://web.whatsapp.com', allow: [], deny: [] },
  { id: 'telegram', name: 'Telegram', url: 'https://web.telegram.org/a/', allow: [], deny: [] },
  { id: 'slack', name: 'Slack', url: 'https://app.slack.com/client', allow: [], deny: [] },
  { id: 'discord', name: 'Discord', url: 'https://discord.com/app', allow: [], deny: [] },
  { id: 'proton', name: 'Proton', url: 'https://mail.proton.me', allow: [], deny: [] },
  { id: 'linkedin', name: 'LinkedIn', url: 'https://www.linkedin.com/messaging/', allow: [], deny: [] },
  // hidden by default (see SET_DEFAULTS): Google blocks sign-in in embedded browsers
  { id: 'gmail', name: 'Gmail (non funziona: servirebbe IMAP)', url: 'https://mail.google.com', allow: [], deny: [] },
];

const BAR = 44; // tab strip height
const AR = 10; // arrow height
const R = 12; // corner radius
// sites refuse a browser that says "Electron"
const UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

const major = process.versions.chrome.split('.')[0];
const CH_UA = `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not;A=Brand";v="8"`;

let win, bar, tray, settingsView, servicesFile, current, settingsOpen = false, arrowX = null;
const services = [];
const views = {}; // service id -> WebContentsView
const unread = {};

// settings.json. Every key has a validator: nothing else gets in from the renderer.
const ICONS = [['cubo', 'Cubo'], ['pieno', 'Pieno'], ['contorno', 'Contorno'], ['aperto', 'Aperto']];
const SHORTCUTS = ['', 'Alt+Cmd+O', 'Ctrl+Alt+Space'];
const bool = (v) => typeof v === 'boolean';
const HHMM = /^\d\d:\d\d$/;
const VALID = {
  theme: (v) => ['system', 'light', 'dark'].includes(v),
  notifications: bool,
  quiet: (v) => v && bool(v.on) && HHMM.test(v.from) && HHMM.test(v.to),
  muted: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  hidden: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length < services.length, // at least one tab stays
  icon: (v) => ICONS.some(([k]) => k === v),
  launchAtLogin: bool, closeOnBlur: bool, showCount: bool, animate: bool,
  clearCacheOnQuit: bool,
  zoom: (v) => typeof v === 'number' && v >= 0.5 && v <= 1,
  width: (v) => Number.isInteger(v) && v >= 420 && v <= 1400,
  shortcut: (v) => SHORTCUTS.includes(v),
};
const SET_DEFAULTS = { theme: 'system', notifications: true, quiet: { on: false, from: '22:00', to: '08:00' }, muted: [], hidden: ['gmail'], icon: 'cubo', launchAtLogin: false, closeOnBlur: true, showCount: true, shortcut: '', zoom: 0.8, width: 820, clearCacheOnQuit: true, animate: true };
let S = SET_DEFAULTS;
const setFile = () => path.join(app.getPath('userData'), 'settings.json');
const fromFile = (e) => e.senderFrame.url.startsWith('file:');

function loadSettings() {
  try { S = { ...SET_DEFAULTS, ...JSON.parse(fs.readFileSync(setFile(), 'utf8')) }; } catch { S = { ...SET_DEFAULTS }; }
  // stale or invalid values fall back to the default
  for (const k of Object.keys(SET_DEFAULTS)) if (VALID[k] && !VALID[k](S[k])) S[k] = SET_DEFAULTS[k];
}

function applySettings() {
  nativeTheme.themeSource = S.theme;
  if (!animating) tray.setImage(trayImage(S.icon));
  // only on change: macOS logs an error even for a repeated "no"
  if (app.getLoginItemSettings().openAtLogin !== S.launchAtLogin) app.setLoginItemSettings({ openAtLogin: S.launchAtLogin });
  globalShortcut.unregisterAll();
  if (S.shortcut) globalShortcut.register(S.shortcut, togglePanel);
  for (const [id, v] of Object.entries(views)) {
    v.webContents.setZoomFactor(S.zoom);
    v.webContents.setAudioMuted(S.muted.includes(id));
  }
  if (S.hidden.includes(current)) select(visible()[0].id); // the open tab was just hidden
  if (win.getSize()[0] !== S.width) { win.setSize(S.width, win.getSize()[1]); if (win.isVisible()) showPanel(); }
  pushState();
}

// Clears HTTP cache and Cache Storage (where seen photos and files end up). IndexedDB stays: it keeps the logins.
const clearCaches = () => Promise.all(Object.values(views).map(async (v) => {
  const ses = v.webContents.session;
  await ses.clearCache();
  await ses.clearStorageData({ storages: ['cachestorage'] });
}));
let cleaned = false;
app.on('before-quit', (e) => {
  if (!S.clearCacheOnQuit || cleaned) return;
  e.preventDefault();
  cleaned = true;
  // time-boxed: quitting must never hang on the cache
  Promise.race([clearCaches().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]).finally(() => app.quit());
});

// Tray animations (Cube icon only): frames from assets/, one every `ms`, then back to rest
const trayImage = (name) => nativeImage.createFromPath(path.join(__dirname, 'assets', `${name}Template@2x.png`));
let animating = false;
let waWc = null;
function playTray(frames, ms) {
  if (!S.animate || S.icon !== 'cubo' || animating) return;
  animating = true;
  let i = 0;
  const step = () => {
    if (i < frames.length) { tray.setImage(trayImage(frames[i++])); setTimeout(step, ms); } else { tray.setImage(trayImage(S.icon)); animating = false; }
  };
  step();
}
const START_FRAMES = [0, 1, 2, 3].map((i) => `start-${i}`);
const PULSE_FRAMES = [0, 1].map((i) => `pulse-${i}`);

const visible = () => services.filter((s) => !S.hidden.includes(s.id));

function updateSettings(patch) {
  for (const [k, v] of Object.entries(patch)) if (VALID[k]?.(v)) S[k] = v;
  fs.writeFileSync(setFile(), JSON.stringify(S, null, 2));
  applySettings();
}

const togglePanel = () => (win.isVisible() ? win.hide() : showPanel());

function toggleSettings() {
  settingsOpen = !settingsOpen;
  settingsView.setVisible(settingsOpen);
  if (settingsOpen) settingsView.webContents.send('open');
  pushState();
}

function loadServices() {
  const file = path.join(app.getPath('userData'), 'services.json');
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2));
  servicesFile = file;
  try {
    services.push(...JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    services.push(...DEFAULTS); // broken file (hand-edited): start anyway and warn
    new Notification({ title: 'Onebox', body: `services.json non valido (${e.message.slice(0, 80)}). Uso i servizi di default.` }).show();
  }
}

// The arrow points at the icon, not at the middle of the tray item (which includes the count). Measured: icon at x+21, or x+23 when the item is wider than 50 (count shown).
const arrowFor = (t, winX) => Math.min(Math.max(Math.round(t.x + (t.width > 50 ? 23 : 21) - winX), R + 12), win.getSize()[0] - R - 12);

function pushState() {
  if (win?.isVisible() && arrowX != null) arrowX = arrowFor(tray.getBounds(), win.getPosition()[0]); // the count changes the item width
  // a muted service counts neither on its tab nor next to the icon
  const list = visible().map((s) => ({ id: s.id, name: s.name, unread: S.muted.includes(s.id) ? 0 : unread[s.id] || 0 }));
  bar.webContents.send('state', { current, settingsOpen, arrowX, list });
  const total = list.reduce((a, s) => a + s.unread, 0);
  tray.setTitle(S.showCount && total ? ` ${total}` : '');
}

function layout() {
  const [w, h] = win.getContentSize();
  const top = AR + BAR;
  // the bar extends R px behind the pages so their rounded corners show its color, not a gap
  bar.setBounds({ x: 0, y: 0, width: w, height: top + R });
  for (const v of [...Object.values(views), settingsView]) v.setBounds({ x: 0, y: top, width: w, height: h - top });
}

function select(id) {
  if (S.hidden.includes(id)) return;
  current = id;
  settingsOpen = false;
  settingsView.setVisible(false);
  for (const [k, v] of Object.entries(views)) v.setVisible(k === id);
  pushState();
}

function addService(svc) {
  const view = new WebContentsView({
    webPreferences: {
      partition: `persist:${svc.id}`, // separate cookies and logins per service
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // otherwise background tabs stop receiving messages
    },
  });
  view.setBorderRadius(R);
  const wc = view.webContents;
  wc.setUserAgent(UA);
  // Google rejects sign-in when "Google Chrome" is missing from the brands
  wc.session.webRequest.onBeforeSendHeaders((d, cb) => {
    const h = d.requestHeaders;
    for (const k of Object.keys(h)) if (k.toLowerCase() === 'sec-ch-ua') delete h[k];
    h['sec-ch-ua'] = CH_UA;
    cb({ requestHeaders: h });
  });
  // only notifications; camera, microphone, location etc. denied
  wc.session.setPermissionRequestHandler((_w, perm, cb) => cb(perm === 'notifications'));
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // the number in the page title, "(3) WhatsApp", is the unread count
  wc.on('page-title-updated', (_e, title) => {
    const m = /^[(\[](\d+)[)\]]/.exec(title);
    unread[svc.id] = m ? Number(m[1]) : 0;
    pushState();
  });
  wc.setAudioMuted(S.muted.includes(svc.id));
  // web apps are wide: zoom out to fit the columns. Reapplied on every navigation, Chromium resets it
  for (const ev of ['dom-ready', 'did-finish-load', 'did-navigate', 'did-navigate-in-page']) wc.on(ev, () => wc.setZoomFactor(S.zoom));
  if (new URL(svc.url).hostname === 'web.whatsapp.com') waWc = wc;
  wc.loadURL(svc.url);
  win.contentView.addChildView(view);
  views[svc.id] = view;
}

ipcMain.on('select', (_e, id) => views[id] && select(id));
ipcMain.on('gear', toggleSettings);
// "‹ Chat" button in single-column mode: same as Esc, which closes the open chat
ipcMain.on('wa-back', (e) => {
  if (e.sender !== waWc) return;
  waWc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  waWc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
});
// right click on a tab: hide / mute / reload
ipcMain.on('tab-menu', (e, id) => {
  if (e.sender !== bar.webContents || !views[id]) return;
  const muted = S.muted.includes(id);
  Menu.buildFromTemplate([
    { label: 'Nascondi scheda', enabled: visible().length > 1, click: () => updateSettings({ hidden: [...S.hidden, id] }) },
    { label: muted ? 'Riattiva notifiche e conteggio' : 'Silenzia notifiche e conteggio', click: () => updateSettings({ muted: muted ? S.muted.filter((x) => x !== id) : [...S.muted, id] }) },
    { type: 'separator' },
    { label: 'Ricarica', click: () => views[id].webContents.reload() },
  ]).popup({ window: win });
});
ipcMain.handle('settings:get', (e) => (fromFile(e) ? { settings: S, services: services.map(({ id, name }) => ({ id, name })), icons: ICONS, version: app.getVersion() } : null));
ipcMain.handle('settings:set', (e, patch) => {
  if (!fromFile(e)) return S;
  updateSettings(patch);
  return S;
});
ipcMain.on('settings:quit', (e) => fromFile(e) && app.quit());

ipcMain.on('notify', (e, title, body) => {
  const svc = services.find((s) => views[s.id]?.webContents === e.sender);
  if (!svc || !S.notifications || S.muted.includes(svc.id) || inQuiet(S.quiet) || !passes(svc, title, body)) return;
  playTray(PULSE_FRAMES, 130);
  const n = new Notification({ title: `${svc.name} · ${title}`, body });
  n.on('click', () => { showPanel(); select(svc.id); });
  n.show();
});

// The panel drops below the menu bar icon
function showPanel() {
  const t = tray.getBounds();
  const [w, h] = win.getSize();
  // if macOS hides the icon (full bar, icon manager) the bounds are off-screen: top-right fallback
  const hidden = t.x < 0 || t.width === 0;
  const { workArea } = hidden ? screen.getPrimaryDisplay() : screen.getDisplayMatching(t);
  const x = hidden ? workArea.x + workArea.width - w - 8 : Math.min(Math.max(Math.round(t.x + t.width / 2 - w / 2), workArea.x + 8), workArea.x + workArea.width - w - 8);
  win.setPosition(x, hidden ? workArea.y + 4 : t.y + t.height - 1);
  arrowX = hidden ? null : arrowFor(t, x);
  win.setSize(w, Math.min(h, workArea.height - 16));
  pushState();
  win.show();
  app.focus({ steal: true });
  // the icon bounds settle after the click: recompute the arrow
  for (const ms of [80, 300]) setTimeout(() => win.isVisible() && pushState(), ms);
}

app.whenReady().then(() => {
  loadServices();
  loadSettings();
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('Onebox');
  tray.on('click', togglePanel);
  tray.on('right-click', () => tray.popUpContextMenu(Menu.buildFromTemplate([
    { label: 'Impostazioni…', click: () => { showPanel(); if (!settingsOpen) toggleSettings(); } },
    { label: 'Modifica servizi… (poi riavvia)', click: () => shell.openPath(servicesFile) },
    { type: 'separator' },
    { label: 'Esci da Onebox', click: () => app.quit() },
  ])));

  win = new BrowserWindow({ width: S.width, height: 780, show: false, frame: false, resizable: true, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, transparent: true, backgroundColor: '#00000000', hasShadow: true });
  win.on('blur', () => S.closeOnBlur && win.hide()); // click outside closes it
  bar = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } });
  bar.webContents.loadFile(path.join(__dirname, 'tabs.html'));
  win.contentView.addChildView(bar);
  services.forEach(addService);
  settingsView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } });
  settingsView.webContents.loadFile(path.join(__dirname, 'settings.html'));
  settingsView.setBorderRadius(R);
  win.contentView.addChildView(settingsView); // sopra le schede dei servizi
  settingsView.setVisible(false);
  bar.setBackgroundColor('#00000000');
  win.on('resize', layout);
  win.on('resized', () => { S.width = win.getSize()[0]; fs.writeFileSync(setFile(), JSON.stringify(S, null, 2)); }); // remember a dragged width
  layout();
  applySettings();
  playTray(START_FRAMES, 140); // build-up animation at launch
  bar.webContents.once('did-finish-load', () => { select(visible()[0].id); showPanel(); if (process.argv.includes('--settings')) toggleSettings(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'Servizi', submenu: [
      ...services.map((s, i) => ({ label: s.name, accelerator: `Cmd+${i + 1}`, click: () => select(s.id) })),
      { type: 'separator' },
      { label: 'Modifica servizi… (poi riavvia)', click: () => shell.openPath(servicesFile) },
    ] },
  ]));
});
