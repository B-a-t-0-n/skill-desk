"use strict";

(() => {
  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke || !tauri?.event?.listen || window.skillDesk) return;

  const subscriptions = new Set();
  const invoke = (command, args) => tauri.core.invoke(command, args);

  function subscribe(name, callback) {
    if (typeof callback !== "function") throw new TypeError("Нужна функция обратного вызова.");
    let disposed = false;
    let unlisten;
    const ready = tauri.event.listen(name, (event) => {
      if (!disposed) callback(event.payload);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch((error) => console.error(`Skill Desk: ${name}`, error));
    subscriptions.add(ready);
    ready.finally(() => subscriptions.delete(ready));
    return () => {
      disposed = true;
      if (unlisten) { unlisten(); unlisten = undefined; }
    };
  }

  window.skillDesk = Object.freeze({
    getSnapshot: async () => {
      // Listen before requesting the first snapshot so updates cannot fall in the gap.
      await Promise.all([...subscriptions]);
      return invoke("get_snapshot");
    },
    refresh: () => invoke("refresh"),
    openWidget: (sessionId) => invoke("open_widget", { sessionId }),
    setAlwaysOnTop: (value) => invoke("set_always_on_top", { value }),
    windowAction: (action) => invoke("window_action", { action }),
    setPreferences: (patch) => invoke("set_preferences", { patch }),
    onUpdate: (callback) => subscribe("skill-desk:update", callback),
    onNotice: (callback) => subscribe("skill-desk:notice", callback),
  });

  document.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.defaultPrevented || !(event.target instanceof Element)) return;
    const header = event.target.closest(".titlebar, .widget-header");
    if (!header || event.target.closest("button, input, select, textarea, a, summary, [role='button'], [contenteditable]")) return;
    event.preventDefault();
    invoke("window_action", { action: "drag" }).catch((error) => console.error("Skill Desk: drag", error));
  });
})();
