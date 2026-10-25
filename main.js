const { app, BrowserWindow, WebContentsView, Notification, Tray, ipcMain, shell, Menu, nativeTheme, nativeImage, globalShortcut, screen, net, desktopCapturer } = require('electron');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const path = require('path');
const { passes, inQuiet } = require('./filter');
const STR = require('./i18n');

// two copies would fight over one profile (WhatsApp shows its QR): the second just opens the first's panel
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => win && showPanel());

// Default services, copied to services.json on first run. allow/deny are case-insensitive regexes tested on "title\nbody".
const DEFAULTS = [
  { id: 'whatsapp', name: 'WhatsApp', url: 'https://web.whatsapp.com', allow: [], deny: [] },
  { id: 'telegram', name: 'Telegram', url: 'https://web.telegram.org/a/', allow: [], deny: [] },
  { id: 'slack', name: 'Slack', url: 'https://app.slack.com/client', allow: [], deny: [] },
  { id: 'discord', name: 'Discord', url: 'https://discord.com/app', allow: [], deny: [] },
  { id: 'proton', name: 'Proton', url: 'https://mail.proton.me', allow: [], deny: [] },
  { id: 'linkedin', name: 'LinkedIn', url: 'https://www.linkedin.com/messaging/', allow: [], deny: [] },
  // hidden by default (see SET_DEFAULTS): Google blocks sign-in in embedded browsers
  { id: 'gmail', name: 'Gmail (not working: needs IMAP)', url: 'https://mail.google.com', allow: [], deny: [] },
];

const BAR = 44; // tab strip height
const AR = 10; // arrow height
const R = 12; // corner radius
// sites refuse a browser that says "Electron"
const UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

const major = process.versions.chrome.split('.')[0];
const CH_UA = `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not;A=Brand";v="8"`;

let win, bar, tray, settingsView, servicesFile, current, settingsOpen = false, arrowX = null;
let parked = [], parkedIcon = null, parkedAt = 0; // files dropped on the tray icon, stacked until dragged into a chat
let halo, haloTimer; // "drop here" pill under the icon while a file is dragged over it
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
  launchAtLogin: bool, closeOnBlur: bool, showCount: bool, animate: bool, updateBadge: bool,
  clearCacheOnQuit: bool,
  zoom: (v) => typeof v === 'number' && v >= 0.5 && v <= 1,
  width: (v) => Number.isInteger(v) && v >= 420 && v <= 1400,
  shortcut: (v) => SHORTCUTS.includes(v),
  lang: (v) => v in STR,
};
const SET_DEFAULTS = { theme: 'light', notifications: true, quiet: { on: false, from: '22:00', to: '08:00' }, muted: [], hidden: ['gmail'], icon: 'cubo', launchAtLogin: false, closeOnBlur: true, showCount: true, lang: 'en', shortcut: '', zoom: 0.8, width: 820, clearCacheOnQuit: true, animate: true, updateBadge: true };
let S = SET_DEFAULTS;
const T = () => STR[S.lang];
const setFile = () => path.join(app.getPath('userData'), 'settings.json');
const fromFile = (e) => e.senderFrame.url.startsWith('file:');

function loadSettings() {
  try { S = { ...SET_DEFAULTS, ...JSON.parse(fs.readFileSync(setFile(), 'utf8')) }; } catch { S = { ...SET_DEFAULTS }; }
  // stale or invalid values fall back to the default
  for (const k of Object.keys(SET_DEFAULTS)) if (VALID[k] && !VALID[k](S[k])) S[k] = SET_DEFAULTS[k];
}

function applySettings() {
  nativeTheme.themeSource = S.theme;
  buildAppMenu();
  if (!animating) tray.setImage(restIcon());
  globalShortcut.unregisterAll();
  if (S.shortcut) globalShortcut.register(S.shortcut, togglePanel);
  for (const [id, v] of Object.entries(views)) {
    v.webContents.setZoomFactor(S.zoom);
  }
  applyAudio();
  if (S.hidden.includes(current)) select(visible()[0].id); // the open tab was just hidden
  if (win.getSize()[0] !== S.width) { win.setSize(S.width, win.getSize()[1]); if (win.isVisible()) showPanel(); }
  pushState();
}

// Clears Cache Storage (seen photos and files). The HTTP cache holds each site's code: wiping it cost
// WhatsApp ~10 MB and ~8 s per start. IndexedDB holds the logins.
const clearCaches = () => Promise.all(Object.values(views).map((v) =>
  v.webContents.session.clearStorageData({ storages: ['cachestorage'] })));
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
// the resting icon: soft orange (not a template, macOS keeps the colour) while an update is waiting
const restIcon = () => (latest && S.updateBadge ? nativeImage.createFromPath(path.join(__dirname, 'assets', `${S.icon}-orange@2x.png`)) : trayImage(S.icon));
let animating = false;
let waWc = null;
function playTray(frames, ms) {
  if (!S.animate || S.icon !== 'cubo' || animating) return;
  animating = true;
  let i = 0;
  const step = () => {
    if (i < frames.length) { tray.setImage(trayImage(frames[i++])); setTimeout(step, ms); } else { tray.setImage(restIcon()); animating = false; }
  };
  step();
}
const START_FRAMES = [0, 1, 2, 3].map((i) => `start-${i}`);
const PULSE_FRAMES = [0, 1].map((i) => `pulse-${i}`);

const visible = () => services.filter((s) => !S.hidden.includes(s.id));

function updateSettings(patch) {
  for (const [k, v] of Object.entries(patch)) if (VALID[k]?.(v)) S[k] = v;
  fs.writeFileSync(setFile(), JSON.stringify(S, null, 2));
  // only when that switch changes: every registration makes macOS show a "login item added" notice
  if ('launchAtLogin' in patch) app.setLoginItemSettings({ openAtLogin: S.launchAtLogin });
  applySettings();
}

function buildAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: T().menuServices, submenu: [
      ...services.map((s, i) => ({ label: s.name, accelerator: `Cmd+${i + 1}`, click: () => select(s.id) })),
      { type: 'separator' },
      { label: T().editServices, click: () => shell.openPath(servicesFile) },
    ] },
  ]));
}

const togglePanel = () => (win.isVisible() ? win.hide() : showPanel());

// Dragging a file in starts with a click in Finder, which blurs the panel. Wait for the mouse button
// to be released (Electron can't read it, AppKit can): released over the panel = a drop, keep it open.
function hideUnlessDrop() {
  const js = "ObjC.import('AppKit'); const was = $.NSEvent.pressedMouseButtons & 1; while ($.NSEvent.pressedMouseButtons & 1) delay(0.03); was ? 'down' : ''";
  execFile('osascript', ['-l', 'JavaScript', '-e', js], (_err, out) => {
    if (!win.isVisible()) return;
    const p = screen.getCursorScreenPoint(), b = win.getBounds();
    const over = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    if (String(out).trim() === 'down' && over) { app.focus({ steal: true }); win.focus(); } else win.hide();
  });
}

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
    new Notification({ title: 'Onebox', body: T().badServices.replace('{0}', e.message.slice(0, 80)) }).show();
  }
}

// The arrow points at the cube, not the item's centre. Measured: x+21, x+23 when the count widens it past 50.
const arrowFor = (t, winX) => Math.min(Math.max(Math.round(t.x + (t.width > 50 ? 23 : 21) - winX), R + 12), win.getSize()[0] - R - 12);

function pushState() {
  if (win?.isVisible() && arrowX != null) arrowX = arrowFor(tray.getBounds(), win.getPosition()[0]); // the count changes the item width
  // a muted service counts neither on its tab nor next to the icon
  const list = visible().map((s) => ({ id: s.id, name: s.name, unread: S.muted.includes(s.id) ? 0 : unread[s.id] || 0 }));
  bar.webContents.send('state', { current, settingsOpen, arrowX, list, gearTitle: T().settings, dropSlot: T().dropSlot, parked: parked.length ? {
    label: parked.length > 1 ? T().nFiles.replace('{0}', parked.length) : parked[0].name,
    tip: parked.map((f) => [f.name, f.info].filter(Boolean).join(' · ')).join('\n'),
    thumbs: parked.slice(-3).map((f) => f.thumb), at: parkedAt,
  } : null });
  const total = list.reduce((a, s) => a + s.unread, 0);
  // a waiting update replaces the count: side by side they read as one number
  if (!animating) tray.setImage(restIcon());
  tray.setTitle(latest && S.updateBadge ? ` ↑${latest}` : S.showCount && total ? ` ${total}` : '');
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
  applyAudio();
  pushState();
}

// a muted service stays silent in the background, but the tab in front of you plays (videos, voice notes)
function applyAudio() {
  const open = win?.isVisible();
  for (const [id, v] of Object.entries(views)) v.webContents.setAudioMuted(S.muted.includes(id) && !(open && id === current));
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
  // calls, copy buttons and video fullscreen work; reading the clipboard, location etc. denied
  const ALLOW = ['notifications', 'media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'];
  wc.session.setPermissionRequestHandler((_w, perm, cb) => cb(ALLOW.includes(perm)));
  // screen sharing: macOS 15+ shows its own picker; older systems share the main screen
  wc.session.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((s) => cb({ video: s[0] }), () => cb({}));
  }, { useSystemPicker: true });
  // a Save dialog would hang off the hidden panel: save straight to Downloads
  wc.session.on('will-download', (_e, item) => {
    const dir = app.getPath('downloads'), ext = path.extname(item.getFilename()), base = path.basename(item.getFilename(), ext);
    let file = path.join(dir, item.getFilename());
    for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `${base} (${i})${ext}`);
    item.setSavePath(file);
    item.once('done', (_e, state) => {
      if (state !== 'completed') return;
      const n = new Notification({ title: 'Onebox', body: T().downloaded.replace('{0}', path.basename(file)) });
      n.on('click', () => shell.showItemInFolder(file));
      n.show();
    });
  });
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
  wc.setAudioMuted(S.muted.includes(svc.id) && !(win?.isVisible() && svc.id === current));
  // web apps are wide: zoom out to fit the columns. Reapplied on every navigation, Chromium resets it
  for (const ev of ['dom-ready', 'did-finish-load', 'did-navigate', 'did-navigate-in-page']) wc.on(ev, () => wc.setZoomFactor(S.zoom));
  if (new URL(svc.url).hostname === 'web.whatsapp.com') waWc = wc;
  wc.loadURL(svc.url);
  win.contentView.addChildView(view);
  views[svc.id] = view;
}

ipcMain.on('select', (_e, id) => views[id] && select(id));
ipcMain.on('gear', toggleSettings);
// the stack leaves as real files, so any target takes it: a chat, Mail, Finder
ipcMain.on('park-drag', (e) => parked.length && e.sender === bar.webContents && e.sender.startDrag({ file: parked[0].path, files: parked.map((f) => f.path), icon: parkedIcon }));
ipcMain.on('park-files', (e, paths) => e.sender === bar.webContents && parkFiles(paths.filter((f) => typeof f === 'string' && f && fs.existsSync(f))));
ipcMain.on('drag-hint', (e) => Object.values(views).some((v) => v.webContents === e.sender) && bar.webContents.send('drag-hint'));
ipcMain.on('unpark', (e) => { if (e.sender === bar.webContents) { parked = []; pushState(); } });
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
    { label: T().hideTab, enabled: visible().length > 1, click: () => updateSettings({ hidden: [...S.hidden, id] }) },
    { label: muted ? T().unmute : T().mute, click: () => updateSettings({ muted: muted ? S.muted.filter((x) => x !== id) : [...S.muted, id] }) },
    { type: 'separator' },
    { label: T().reload, click: () => views[id].webContents.reload() },
  ]).popup({ window: win });
});
// Update check: GitHub's latest release, once a day. Download and install only on the button.
const RELEASES = 'https://github.com/stek765/OneBox/releases/latest';
// ONEBOX_UPDATE_API: a local feed, to test an update without publishing one
const API = process.env.ONEBOX_UPDATE_API || 'https://api.github.com/repos/stek765/OneBox/releases/latest';
const TRUSTED = process.env.ONEBOX_UPDATE_API ? /^(https:\/\/github\.com\/stek765\/OneBox\/|http:\/\/127\.0\.0\.1:)/ : /^https:\/\/github\.com\/stek765\/OneBox\//;
let latest = null, asset = null;
let upd = { state: 'idle', pct: 0 }; // idle | downloading | ready | error
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
const setUpd = (u) => { upd = u; settingsView?.webContents.send('update-state'); };
async function checkUpdate() {
  try {
    const r = await net.fetch(API, { headers: { Accept: 'application/vnd.github+json' } });
    const rel = r.ok && (await r.json());
    const v = String(rel.tag_name || '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(v) || !newer(v, app.getVersion()) || latest === v) return;
    // a file and its sha256 as GitHub reports them; without a digest we only point to the release page
    const ok = (x) => x && /^sha256:[0-9a-f]{64}$/.test(x.digest || '') && TRUSTED.test(x.browser_download_url);
    const pick = (x, kind) => ({ url: x.browser_download_url, sha256: x.digest.slice(7), name: x.name, kind });
    // same Electron as ours: the bundle minus Electron (~300 KB) instead of the whole dmg (~130 MB)
    const find = (n) => (rel.assets || []).find((x) => x.name === n), E = process.versions.electron;
    const signed = find(`Onebox-signed-${v}-electron${E}.zip`), zip = find(`Onebox-app-${v}-electron${E}.zip`);
    const dmg = (rel.assets || []).find((x) => /-arm64\.dmg$/.test(x.name));
    // signed parts keep a certificate-signed app's identity (macOS keeps its permissions);
    // an ad-hoc app takes the dmg once to get that identity
    asset = ok(signed) && (await certSigned()) ? pick(signed, 'signed') : ok(zip) && !ok(signed) ? pick(zip, 'app') : ok(dmg) ? pick(dmg, 'dmg') : null;
    latest = v;
    pushState();
    const n = new Notification({ title: 'Onebox', body: T().updateAvailable.replace('{0}', v) });
    n.on('click', () => { showPanel(); if (!settingsOpen) toggleSettings(); });
    n.show();
  } catch { /* offline: try again tomorrow */ }
}
// the running bundle (…/Onebox.app); null when started from source
const appBundle = () => { const p = path.resolve(process.execPath, '../../..'); return p.endsWith('.app') ? p : null; };
const certSigned = () => new Promise((ok) => (appBundle() ? execFile('codesign', ['-dr', '-', appBundle()], (_e, out, err) => ok(/certificate leaf/.test(out + err))) : ok(false)));
async function downloadUpdate() {
  if (!asset || !appBundle() || upd.state === 'downloading') return shell.openExternal(RELEASES);
  const file = path.join(os.tmpdir(), asset.name);
  setUpd({ state: 'downloading', pct: 0 });
  try {
    const r = await net.fetch(asset.url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const total = Number(r.headers.get('content-length')) || 0, hash = crypto.createHash('sha256'), out = fs.createWriteStream(file);
    let got = 0, last = 0;
    for await (const chunk of r.body) {
      hash.update(chunk); got += chunk.length;
      if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok));
      const pct = total ? Math.floor((got / total) * 100) : 0;
      if (pct >= last + 2) { last = pct; setUpd({ state: 'downloading', pct }); }
    }
    await new Promise((ok) => out.end(ok));
    if (hash.digest('hex') !== asset.sha256) throw new Error('checksum mismatch');
    setUpd({ state: 'ready', pct: 100, file, kind: asset.kind });
  } catch (e) {
    fs.rm(file, () => {});
    setUpd({ state: 'error', pct: 0 });
  }
}
// After exit: verify the new app, swap it in, reopen. Any failure leaves the old app untouched.
function installUpdate() {
  if (upd.state !== 'ready') return;
  const swap = 'codesign --verify --deep --strict "$3.new" && rm -rf "$3" && mv "$3.new" "$3" || rm -rf "$3.new"; ';
  const script = 'while kill -0 "$1" 2>/dev/null; do sleep 0.3; done; '
    + (upd.kind === 'signed'
      // the signed parts over a copy; should they not match this Electron, fall back to ad-hoc rather than fail
      ? 'ditto "$3" "$3.new" && rm -rf "$3.new/Contents/Resources/app" && ditto -x -k "$2" "$3.new" && { codesign --verify --deep --strict "$3.new" 2>/dev/null || codesign --force --deep --sign - "$3.new"; } && ' + swap
      : upd.kind === 'app'
      // new code into a copy of this app, then re-sign: editing the bundle breaks the signature
      ? 'ditto "$3" "$3.new" && rm -rf "$3.new/Contents/Resources/app" && ditto -x -k "$2" "$3.new/Contents/Resources" && codesign --force --deep --sign - "$3.new" && ' + swap
      : 'M=$(mktemp -d); if hdiutil attach -nobrowse -readonly -mountpoint "$M" "$2" >/dev/null; then ditto "$M/Onebox.app" "$3.new" && ' + swap + 'hdiutil detach "$M" -quiet; fi; ')
    + 'rm -f "$2"; open "$3"';
  spawn('/bin/sh', ['-c', script, 'sh', String(process.pid), upd.file, appBundle()], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}
ipcMain.on('settings:update', (e) => fromFile(e) && downloadUpdate());
ipcMain.on('settings:release', (e) => fromFile(e) && shell.openExternal(RELEASES));
ipcMain.on('settings:install', (e) => fromFile(e) && installUpdate());
const settingsPayload = () => ({ settings: S, t: T(), services: services.map(({ id, name }) => ({ id, name })), icons: ICONS, version: app.getVersion(), latest, upd: { state: upd.state, pct: upd.pct }, canInstall: !!(asset && appBundle()) });
ipcMain.handle('settings:get', (e) => (fromFile(e) ? settingsPayload() : null));
ipcMain.handle('settings:set', (e, patch) => {
  if (!fromFile(e)) return null;
  updateSettings(patch);
  return settingsPayload();
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

const HALO = `<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  .p { position: absolute; left: 50%; top: 8px; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; padding: 9px 16px 9px 12px; border-radius: 15px;
    background: linear-gradient(135deg, #ffb36b, #ff8a3d); color: #fff; font: 600 13px -apple-system, sans-serif; white-space: nowrap;
    box-shadow: 0 8px 24px rgba(255, 138, 61, .45), inset 0 0 0 1px rgba(255, 255, 255, .35);
    animation: in .38s cubic-bezier(.2, .9, .25, 1.25) both, glow 1.2s ease-in-out .4s infinite; }
  .p::before { content: ''; position: absolute; left: 50%; top: -5px; width: 11px; height: 11px; margin-left: -5px; background: #ffad62; transform: rotate(45deg); border-radius: 2px; }
  .a { display: inline-block; font-size: 15px; animation: bob .9s ease-in-out infinite; }
  body.in .p { animation: out .24s ease-in forwards; }
  @keyframes in { from { opacity: 0; transform: translate(-50%, -14px) scale(.7); } }
  @keyframes out { to { opacity: 0; transform: translate(-50%, -26px) scale(.25); } }
  @keyframes glow { 50% { box-shadow: 0 8px 34px rgba(255, 138, 61, .8), inset 0 0 0 1px rgba(255, 255, 255, .55); } }
  @keyframes bob { 50% { transform: translateY(-3px); } }
</style><div class="p"><span class="a">↑</span>{0}</div>`;

function showHalo() {
  clearTimeout(haloTimer);
  if (halo?.isVisible()) return;
  const t = tray.getBounds();
  if (t.x < 0 || t.width === 0) return; // icon hidden by the system or Ice: nowhere to point
  if (!halo) {
    halo = new BrowserWindow({ width: 260, height: 70, show: false, frame: false, transparent: true, resizable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, webPreferences: { sandbox: true } });
    halo.setIgnoreMouseEvents(true);
  }
  halo.setPosition(Math.round(t.x + (t.width > 50 ? 23 : 21) - 130), t.y + t.height);
  halo.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HALO.replace('{0}', T().dropHere))}`);
  halo.showInactive();
  if (!animating) tray.setImage(nativeImage.createFromPath(path.join(__dirname, 'assets', `${S.icon}-orange@2x.png`)));
}

// absorb = the file was dropped: the pill shrinks into the icon instead of just vanishing
function hideHalo(absorb) {
  clearTimeout(haloTimer);
  if (!animating) tray.setImage(restIcon());
  if (!halo?.isVisible()) return;
  if (!absorb) return halo.hide();
  halo.webContents.executeJavaScript("document.body.className = 'in'").catch(() => {});
  setTimeout(() => halo.hide(), 250);
}

async function parkFiles(files) {
  // startDrag needs the icon ready, so it is made here
  for (const file of files) {
    if (parked.some((f) => f.path === file)) continue;
    // Quick Look thumbnail (a PDF's first page, the photo), else the Finder icon
    const img = await nativeImage.createThumbnailFromPath(file, { width: 120, height: 120 }).catch(() => app.getFileIcon(file, { size: 'large' }));
    const st = fs.statSync(file), ext = path.extname(file).slice(1).toUpperCase();
    const kb = st.size / 1024, size = kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`;
    parked.push({ path: file, name: path.basename(file), info: st.isDirectory() ? '' : [ext, size].filter(Boolean).join(' · '), thumb: img.toDataURL() });
    parkedIcon = img.resize({ width: 64 });
  }
  parkedAt = Date.now();
  showPanel();
}

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
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); // else it snaps back to whatever Space it last showed on
  win.show();
  win.setVisibleOnAllWorkspaces(false);
  app.focus({ steal: true });
  // the icon bounds settle after the click: recompute the arrow
  for (const ms of [80, 300]) setTimeout(() => win.isVisible() && pushState(), ms);
}

app.whenReady().then(() => {
  if (!gotLock) return;
  loadServices();
  loadSettings();
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('Onebox');
  tray.on('click', togglePanel);
  tray.on('drag-enter', showHalo);
  // the icon is a few points wide: enter/leave fire on every wobble, so leave only after a pause
  tray.on('drag-leave', () => { clearTimeout(haloTimer); haloTimer = setTimeout(() => hideHalo(false), 250); });
  tray.on('drag-end', () => hideHalo(false));
  tray.on('drop-files', (_e, files) => {
    hideHalo(true);
    playTray(PULSE_FRAMES, 130);
    parkFiles(files);
  });
  tray.on('right-click', () => tray.popUpContextMenu(Menu.buildFromTemplate([
    { label: T().openSettings, click: () => { showPanel(); if (!settingsOpen) toggleSettings(); } },
    { label: T().editServices, click: () => shell.openPath(servicesFile) },
    { type: 'separator' },
    { label: T().quitMenu, click: () => app.quit() },
  ])));

  win = new BrowserWindow({ width: S.width, height: 780, show: false, frame: false, resizable: true, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, transparent: true, backgroundColor: '#00000000', hasShadow: true });
  win.on('blur', () => S.closeOnBlur && hideUnlessDrop()); // click outside closes it
  bar = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } });
  bar.webContents.loadFile(path.join(__dirname, 'tabs.html'));
  win.contentView.addChildView(bar);
  services.forEach(addService);
  settingsView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } });
  settingsView.webContents.loadFile(path.join(__dirname, 'settings.html'));
  settingsView.setBorderRadius(R);
  win.contentView.addChildView(settingsView); // above the service tabs
  settingsView.setVisible(false);
  bar.setBackgroundColor('#00000000');
  win.on('show', applyAudio);
  win.on('hide', applyAudio);
  win.on('resize', layout);
  win.on('resized', () => { S.width = win.getSize()[0]; fs.writeFileSync(setFile(), JSON.stringify(S, null, 2)); }); // remember a dragged width
  layout();
  applySettings();
  playTray(START_FRAMES, 140); // build-up animation at launch
  checkUpdate();
  setInterval(checkUpdate, 24 * 3600 * 1000);
  bar.webContents.once('did-finish-load', () => { select(visible()[0].id); showPanel(); if (process.argv.includes('--settings')) toggleSettings(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
});
