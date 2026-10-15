const { contextBridge, ipcRenderer, webFrame } = require('electron');

if (location.protocol === 'file:') {
  // tab bar and settings pages
  contextBridge.exposeInMainWorld('tabs', {
    onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
    select: (id) => ipcRenderer.send('select', id),
    gear: () => ipcRenderer.send('gear'),
    menu: (id) => ipcRenderer.send('tab-menu', id),
  });
  contextBridge.exposeInMainWorld('settings', {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    quit: () => ipcRenderer.send('settings:quit'),
    update: () => ipcRenderer.send('settings:update'),
    openRelease: () => ipcRenderer.send('settings:release'),
    install: () => ipcRenderer.send('settings:install'),
    onUpdate: (cb) => ipcRenderer.on('update-state', cb),
    onOpen: (cb) => ipcRenderer.on('open', cb),
  });
} else {
  // service page: web notifications are routed through here so they can be filtered
  contextBridge.exposeInMainWorld('__inbox', {
    back: () => ipcRenderer.send('wa-back'),
    notify: (title, body) => ipcRenderer.send('notify', String(title).slice(0, 200), String(body).slice(0, 300)),
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
        + '#expressions-panel-container div[style*="transform-origin: center bottom"]{left:76px!important}';
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
      sync();
    })()`);
  }
}
