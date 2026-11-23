const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

if (location.protocol === 'file:') {
  // tab bar and settings pages
  contextBridge.exposeInMainWorld('tabs', {
    onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
    select: (id) => ipcRenderer.send('select', id),
    gear: () => ipcRenderer.send('gear'),
    add: () => ipcRenderer.send('add-tab'),
    toggleServer: () => ipcRenderer.send('toggle-server'),
    menu: (id) => ipcRenderer.send('tab-menu', id),
    reorder: (ids) => ipcRenderer.send('reorder', ids),
    dragParked: () => ipcRenderer.send('park-drag'),
    unpark: () => ipcRenderer.send('unpark'),
    park: (...files) => ipcRenderer.send('park-files', files.map((f) => webUtils.getPathForFile(f))),
    onDragHint: (cb) => ipcRenderer.on('drag-hint', cb),
  });
  contextBridge.exposeInMainWorld('settings', {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    edit: (op, id, ...a) => ipcRenderer.invoke('services:edit', op, id, ...a),
    quit: () => ipcRenderer.send('settings:quit'),
    update: () => ipcRenderer.send('settings:update'),
    openRelease: () => ipcRenderer.send('settings:release'),
    install: () => ipcRenderer.send('settings:install'),
    onUpdate: (cb) => ipcRenderer.on('update-state', cb),
    onOpen: (cb) => ipcRenderer.on('open', cb),
    onFocusAdd: (cb) => ipcRenderer.on('focus-add', cb),
  });
} else {
  // a file dragged over the page: tell the tab bar, which shows where it can be parked
  let hinted = 0;
  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files') || Date.now() - hinted < 100) return;
    hinted = Date.now();
    ipcRenderer.send('drag-hint');
  }, true);
  // service page: web notifications go through Onebox's filters
  contextBridge.exposeInMainWorld('__inbox', {
    back: () => ipcRenderer.send('wa-back'),
    notify: (title, body) => ipcRenderer.send('notify', String(title).slice(0, 200), String(body).slice(0, 300)),
    badge: (n) => ipcRenderer.send('badge', Math.max(0, Math.floor(Number(n) || 0))),
  });
  webFrame.executeJavaScript(`(() => {
    const send = (t, o) => window.__inbox.notify(t, (o && o.body) || '');
    class N extends EventTarget {
      static permission = 'granted';
      static requestPermission(cb) { cb && cb('granted'); return Promise.resolve('granted'); }
      constructor(t, o) { super(); send(t, o); }
      close() {}
    }
    Object.defineProperty(window, 'Notification', { value: N, configurable: true, writable: true });
    if (navigator.userAgentData) {
      const v = navigator.userAgentData.brands.find((b) => b.brand === 'Chromium').version;
      const brands = [...navigator.userAgentData.brands, { brand: 'Google Chrome', version: v }];
      Object.defineProperty(NavigatorUAData.prototype, 'brands', { get: () => brands, configurable: true });
    }
    if (window.ServiceWorkerRegistration)
      ServiceWorkerRegistration.prototype.showNotification = (t, o) => { send(t, o); return Promise.resolve(); };
    // Telegram's unread count comes as an app badge, not in the title
    if (navigator.setAppBadge) {
      const badge = (n) => { window.__inbox.badge(n); return Promise.resolve(); };
      Object.defineProperty(navigator, 'setAppBadge', { value: badge, configurable: true });
      Object.defineProperty(navigator, 'clearAppBadge', { value: () => badge(0), configurable: true });
    }
    // Telegram hands notifications to its service worker, out of this script's reach
    if (window.ServiceWorker) {
      const post = ServiceWorker.prototype.postMessage;
      ServiceWorker.prototype.postMessage = function (m, ...a) {
        if (m && m.type === 'showMessageNotification') { if (!m.payload?.isSilent) send(m.payload?.title, m.payload); return; }
        return post.call(this, m, ...a);
      };
    }
  })()`);
  if (location.hostname === 'web.whatsapp.com') {
    // Single column: while a chat is open (#main) ob-chat-open hides the list (the parent of #side).
    webFrame.executeJavaScript(`(() => {
      const css = 'html.ob-chat-open div:has(> #side){display:none!important}'
        + 'html.ob-chat-open #main header{padding-left:96px!important}'
        + '#ob-back{display:none;position:fixed;top:13px;left:74px;z-index:99999;padding:5px 12px;border:0;border-radius:16px;background:rgba(17,27,33,.85);color:#fff;font:600 13px -apple-system,sans-serif;cursor:pointer}'
        + 'html.ob-chat-open #ob-back{display:block}'
        + 'html .ob-line{border-left-width:0!important}'
        // the emoji panel gets a negative inline left computed for the two-column layout: pin it inside the chat
        + '#expressions-panel-container div[style*="transform-origin: center bottom"]{left:76px!important}'
        // the overlay layer (drop zone, media preview) keeps a 40% slot for the list: collapse it so they cover the chat
        + 'html.ob-chat-open div:has(> div > #side) > div:not(:has(#side)):has(> :nth-child(2):last-child) > :first-child{flex:0 0 0!important;max-width:0!important}';
      let queued = false, wasOpen = false;
      // side drawers keep their two-column size and draw a border across the chat: strip it
      const markLines = () => {
        const main = document.querySelector('#main');
        for (const e of document.querySelectorAll('#app div')) {
          if (main && (main.contains(e) || e.contains(main))) continue;
          const cs = getComputedStyle(e);
          if (parseFloat(cs.borderLeftWidth) > 0 && cs.borderLeftStyle !== 'none' && e.getBoundingClientRect().height > 300) e.classList.add('ob-line');
        }
      };
      const sync = () => {
        queued = false;
        const root = document.documentElement;
        const open = !!document.querySelector('#main');
        root.classList.toggle('ob-chat-open', open);
        if (open && !wasOpen) setTimeout(markLines, 400);
        wasOpen = open;
        if (document.body && !document.getElementById('ob-back')) {
          const st = document.createElement('style'); st.textContent = css; document.head.append(st);
          const b = document.createElement('button'); b.id = 'ob-back'; b.textContent = '‹ Chat';
          b.onclick = () => window.__inbox.back();
          document.body.append(b);
        }
      };
      new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(sync); } }).observe(document, { childList: true, subtree: true });
      // Esc closes an open emoji panel. WhatsApp does it only while the focus is inside the panel;
      // from the message box its Esc closes the whole chat, so there the panel's own button is pressed first.
      addEventListener('keydown', (e) => {
        const panel = document.querySelector('#expressions-panel-container [role=application]');
        if (e.key !== 'Escape' || !panel || panel.contains(document.activeElement)) return;
        const btn = document.querySelector('#main footer button[data-tab="10"]:not([aria-haspopup])');
        if (!btn) return;
        e.preventDefault(); e.stopImmediatePropagation();
        btn.click();
      }, true);
      sync();
    })()`);
  }
  if (location.hostname === 'app.element.io') {
    // Element's dark theme in Onebox's night blue, with a light chat. Panels are recoloured through
    // Element's canvas token, the chat by tagging it .cpd-theme-light (its header dark again).
    const d = '.cpd-theme-dark ';
    const css = d + '.mx_RoomView.cpd-theme-light{--cpd-color-bg-canvas-default:#d3e0f0;'
      + 'background:linear-gradient(160deg,#dde8f6 0%,#cfdcef 55%,#c3d2ea 100%)!important;color:var(--cpd-color-text-primary)}'
      + '.mx_RoomHeader.cpd-theme-dark{color:var(--cpd-color-text-primary)}'
      + d + '.mx_RoomView_body,' + d + '.mx_RoomView_messagePanel,' + d + '.mx_RoomView_MessageList{background:transparent!important}'
      + 'body.cpd-theme-dark,.cpd-theme-dark #matrixchat{background:#191b2a!important}'
      + d + '.mx_SpacePanel{--cpd-color-bg-canvas-default:#151724;background:#151724!important}'
      + d + '.mx_RoomListPanel{--cpd-color-bg-canvas-default:#191b2a;background:#191b2a!important}'
      + d + '.mx_RoomHeader{--cpd-color-bg-canvas-default:#1f2233;background:#1f2233!important}';
    window.addEventListener('DOMContentLoaded', () => {
      const st = document.createElement('style'); st.textContent = css; document.head.append(st);
      // React rebuilds these on every room switch
      const tag = () => {
        if (!document.body.classList.contains('cpd-theme-dark')) return;
        for (const e of document.querySelectorAll('.mx_RoomView:not(.cpd-theme-light)')) e.classList.add('cpd-theme-light');
        for (const e of document.querySelectorAll('.mx_RoomHeader:not(.cpd-theme-dark)')) e.classList.add('cpd-theme-dark');
      };
      let queued = false;
      new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; tag(); }); } }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      tag();
    });
  }
}
