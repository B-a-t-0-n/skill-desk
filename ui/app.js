"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const native = window.skillDesk;
  const requestedWidget = new URLSearchParams(location.search).get("widget");
  const state = {
    data: null,
    selectedId: null,
    filter: "all",
    sessionQuery: "",
    skillQuery: "",
    history: false,
    error: null,
    loading: false,
    lastSuccess: null,
    preferences: { theme: "dark", showSubagents: false },
    signatures: {},
  };
  const icons = {
    brand: '<rect x="3" y="3" width="7" height="7" rx="2"/><path d="M14 6h7M6 14v7m8-7 7 7m0-7-7 7"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    moon: '<path d="M20.8 13.1A9 9 0 0 1 10.9 3.2 9 9 0 1 0 20.8 13.1Z"/>',
    minimize: '<path d="M5 12h14"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    arrow: '<path d="M4 12h15m-5-5 5 5-5 5"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6.1A8 8 0 0 1 19.4 9M4.6 15A8 8 0 0 0 17.9 17.9"/>',
    pin: '<path d="m15 3 6 6-4 1-4 5-1 4-7-7 4-1 5-4 1-4ZM3 21l5-5"/>',
    popout: '<path d="M14 3h7v7m0-7-10 10M10 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5"/>',
    overview: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/>',
    pause: '<path d="M9 7v10M15 7v10"/>',
    minus: '<path d="M7 12h10"/>',
    check: '<path d="m6 12 4 4 8-8"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  };
  const statusLabels = {
    active: "В работе",
    idle: "Ожидание",
    interrupted: "Ход прерван",
    unknown: "Статус неизвестен",
  };
  let toastTimer;

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }

  function text(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
  }

  function objects(value) {
    return Array.isArray(value)
      ? value.filter((item) => item && typeof item === "object") : [];
  }

  function icon(name) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const attributes = {
      viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      "stroke-width": "1.5", "stroke-linecap": "round",
      "stroke-linejoin": "round", class: "icon", "aria-hidden": "true",
    };
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    // This markup comes only from the fixed icon set above. Session data uses textContent.
    node.innerHTML = icons[name] || icons.info;
    return node;
  }

  function iconButton(name, label, action, key, extraClass = "") {
    const button = element("button", `icon-button ${extraClass}`);
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    if (key) button.dataset.focusKey = key;
    button.append(icon(name));
    button.addEventListener("click", action);
    return button;
  }

  function date(value) {
    const result = value ? new Date(value) : null;
    return result && Number.isFinite(result.getTime()) ? result : null;
  }

  function skillName(skill) {
    return text(skill.name) || text(skill.id) || "Без названия";
  }

  function skillKey(skill) {
    return text(skill.path) || text(skill.name) || text(skill.id);
  }

  function inCurrentTurn(signal, session) {
    if (typeof signal.currentTurn === "boolean") return signal.currentTurn;
    return Boolean(session.currentTurnId && signal.turnId === session.currentTurnId);
  }

  function signalsFor(session, history = state.history) {
    return objects(session.skillEvidence).filter((signal) => history || inCurrentTurn(signal, session));
  }

  function normalize(session) {
    const skills = objects(session.skills);
    const available = Array.isArray(session.availableSkills)
      ? objects(session.availableSkills) : skills.filter((skill) => skill.available !== false);
    const evidence = Array.isArray(session.skillEvidence)
      ? objects(session.skillEvidence)
      : skills.flatMap((skill) => objects(skill.evidence).map((signal, index) => ({
        ...signal, name: skill.name, path: skill.path,
        id: `${skill.id || skill.path || skill.name}:${index}`,
      })));
    return { ...session, availableSkills: available, skillEvidence: evidence };
  }

  function sessions() {
    return objects(state.data?.sessions)
      .filter((session) => typeof session.id === "string")
      .filter((session) => state.preferences.showSubagents || !session.parentId)
      .sort((a, b) => Number(b.status === "active") - Number(a.status === "active")
        || (date(b.updatedAt)?.getTime() || 0) - (date(a.updatedAt)?.getTime() || 0));
  }

  function selectedSession() {
    return sessions().find((session) => session.id === state.selectedId);
  }

  function isWidget() {
    return state.data?.window?.kind
      ? state.data.window.kind === "widget" : Boolean(requestedWidget);
  }

  function selectedWidgetSession() {
    const id = state.data?.window?.sessionId || requestedWidget;
    return objects(state.data?.sessions).find((session) => session.id === id);
  }

  function replaceContent(container, fragment) {
    const focusKey = container.contains(document.activeElement)
      ? document.activeElement?.dataset.focusKey : null;
    const scrollTop = container.scrollTop;
    container.replaceChildren(fragment);
    container.scrollTop = scrollTop;
    if (focusKey) {
      Array.from(container.querySelectorAll("[data-focus-key]"))
        .find((node) => node.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
    }
  }

  function toast(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = text(message, "Готово");
    $("toast").classList.add("visible");
    toastTimer = setTimeout(() => $("toast").classList.remove("visible"), 3600);
  }

  function errorMessage(error) {
    return text(error?.message) || text(error) || "Не удалось выполнить действие";
  }

  async function perform(callback) {
    try {
      const result = await callback();
      if (result && typeof result === "object" && Array.isArray(result.sessions)) receive(result);
      return result;
    } catch (error) {
      toast(errorMessage(error));
      return null;
    }
  }

  async function windowAction(action) {
    if (!native) return toast("Управление окнами доступно в приложении Windows");
    return perform(() => native.windowAction(action));
  }

  async function openWidget() {
    if (!native) return toast("Отдельные виджеты доступны в приложении Windows");
    if (state.selectedId) await perform(() => native.openWidget(state.selectedId));
  }

  async function togglePin() {
    if (!native) return toast("Закрепление поверх окон доступно в приложении Windows");
    const next = !state.data?.window?.alwaysOnTop;
    const result = await perform(() => native.setAlwaysOnTop(next));
    if (typeof result === "boolean" && state.data?.window) {
      state.data.window.alwaysOnTop = result;
      renderWidget(true);
    }
  }

  async function setPreferences(patch) {
    if (native) {
      const result = await perform(() => native.setPreferences(patch));
      if (!result || Array.isArray(result.sessions)) return;
      state.preferences = { ...state.preferences, ...patch, ...(result.preferences || result) };
    } else {
      state.preferences = { ...state.preferences, ...patch };
      try { localStorage.setItem("skill-desk:preferences", JSON.stringify(state.preferences)); }
      catch { /* Browser storage is optional. */ }
    }
    ensureSelection();
    render();
  }

  function applyPreferences() {
    document.documentElement.dataset.theme = state.preferences.theme === "light" ? "light" : "dark";
    const nextLight = state.preferences.theme !== "light";
    const label = nextLight ? "Светлая тема" : "Тёмная тема";
    $("theme-button").textContent = label;
    $("theme-button").title = label;
    $("theme-button").setAttribute("aria-label", label);
    $("subagents").checked = Boolean(state.preferences.showSubagents);
  }

  function ensureSelection() {
    const all = sessions();
    if (all.some((session) => session.id === state.selectedId)) return;
    state.selectedId = (all.find((session) => session.id === state.data?.currentSessionId)
      || all.find((session) => session.status === "active") || all[0])?.id || null;
  }

  function receive(data) {
    if (!data || !Array.isArray(data.sessions)) throw new Error("Непонятный формат данных источника");
    state.data = { ...data, sessions: objects(data.sessions).map(normalize) };
    if (data.preferences) state.preferences = { ...state.preferences, ...data.preferences };
    state.lastSuccess = Date.now();
    state.error = null;
    ensureSelection();
    render();
  }

  function connectionState() {
    const stale = state.lastSuccess && Date.now() - state.lastSuccess > 16000;
    const health = state.data?.source?.health;
    const unavailable = Boolean(state.error || health === "error");
    const partial = health === "partial";
    return { stale, unavailable, partial, healthy: Boolean(state.lastSuccess && !stale && !unavailable && !partial) };
  }

  function renderConnection() {
    const connection = connectionState();
    document.body.classList.toggle("connected", connection.healthy);
    const label = connection.unavailable ? "Источник недоступен"
      : connection.stale ? "Снимок устарел"
        : connection.partial ? "Часть данных недоступна"
          : connection.healthy ? "Локальный Codex" : "Подключение";
    $("settings-button").title = label;
    const warnings = Array.isArray(state.data?.warnings)
      ? state.data.warnings.map((warning) => typeof warning === "string" ? warning : text(warning?.message)).filter(Boolean) : [];
    if (state.error) warnings.unshift(state.lastSuccess
      ? "Связь потеряна. Показан последний снимок; переподключаемся автоматически."
      : state.error);
    else if (connection.stale) warnings.unshift("Новые данные не получены. Показан последний снимок.");
    $("source-notice").textContent = warnings.join(" ");
    $("source-notice").hidden = warnings.length === 0;
    $("source-warning").textContent = warnings.join(" ");
    $("source-warning").hidden = warnings.length === 0;
    $("source-name").textContent = text(state.data?.source?.label, "Локальные журналы Codex");
    $("source-detail").textContent = text(state.data?.source?.detail,
      "Локальная база и журналы сессий. Удалённые чаты без локального журнала не видны.");
    const info = Array.isArray(state.data?.source?.info)
      ? state.data.source.info.filter((value) => typeof value === "string") : [];
    $("source-info").replaceChildren(...info.map((message) => element("li", "", message)));
    $("source-info").hidden = info.length === 0;
    const generated = date(state.data?.generatedAt);
    $("source-sync").textContent = generated ? `Последний снимок: ${generated.toLocaleString("ru-RU")}. Автообновление каждые 3 секунды.` : "Данные ещё не получены.";
  }

  function renderSessions() {
    const all = sessions();
    const active = all.filter((session) => session.status === "active");
    document.querySelectorAll("[data-filter]").forEach((button) => {
      const selected = button.dataset.filter === state.filter;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    const query = state.sessionQuery.trim().toLocaleLowerCase("ru-RU");
    const visible = (state.filter === "active" ? active : all).filter((session) =>
      [session.title, session.cwd].join(" ").toLocaleLowerCase("ru-RU").includes(query));
    const signature = JSON.stringify([visible.map((session) => [session.id, session.title,
      session.status]), state.selectedId, state.filter, query]);
    if (signature === state.signatures.sessions) return;
    state.signatures.sessions = signature;
    const fragment = document.createDocumentFragment();
    for (const session of visible) {
      const button = element("button", "session-item");
      button.type = "button";
      button.dataset.sessionId = session.id;
      button.dataset.focusKey = `session:${session.id}`;
      button.setAttribute("aria-current", String(session.id === state.selectedId));
      button.title = text(session.title);
      const heading = element("span", "session-item-heading");
      heading.append(element("i", `status-dot ${text(session.status)}`),
        element("span", "session-item-title", text(session.title, "Сессия без названия")));
      button.append(heading);
      button.addEventListener("click", () => selectSession(session.id));
      fragment.append(button);
    }
    if (!visible.length) fragment.append(element("p", "sidebar-empty", query
      ? "Сессии не найдены"
      : state.filter === "active" ? "Нет сессий в работе"
        : state.data ? "Сессий пока нет" : "Загрузка…"));
    replaceContent($("session-list"), fragment);
  }

  function selectSession(id) {
    if (state.selectedId !== id) {
      state.selectedId = id;
      state.skillQuery = "";
      $("skill-search").value = "";
      document.querySelector(".workspace-scroll").scrollTop = 0;
    }
    renderSessions();
    renderWorkspace();
  }

  function statusSymbol(status) {
    const node = element("span", `status-symbol ${status}`);
    node.setAttribute("aria-hidden", "true");
    if (status === "idle") node.append(icon("pause"));
    if (status === "interrupted") node.append(icon("minus"));
    return node;
  }

  function renderStatus(container, session) {
    const status = Object.hasOwn(statusLabels, session.status) ? session.status : "unknown";
    container.className = `session-status ${status}`;
    container.replaceChildren(statusSymbol(status), element("span", "", text(session.statusLabel) || statusLabels[status]));
    container.title = text(session.statusSource);
  }

  function skillRows(session, history = state.history) {
    const map = new Map();
    for (const skill of objects(session.availableSkills)) {
      map.set(skillKey(skill), { ...skill, available: true, signals: [] });
    }
    for (const signal of signalsFor(session, history)) {
      const key = skillKey(signal);
      if (!map.has(key)) map.set(key, { name: signal.name, path: signal.path, available: false, signals: [] });
      map.get(key).signals.push(signal);
    }
    return [...map.values()].map((skill) => ({
      ...skill,
      loaded: skill.signals.some((signal) => signal.kind === "loaded"),
      declared: skill.signals.some((signal) => signal.kind === "declared"),
      lastAt: skill.signals.map((signal) => signal.at).filter(Boolean).sort().at(-1) || null,
    })).sort((a, b) => Number(b.signals.length > 0) - Number(a.signals.length > 0)
      || (date(b.lastAt)?.getTime() || 0) - (date(a.lastAt)?.getTime() || 0)
      || skillName(a).localeCompare(skillName(b), "ru"));
  }

  function renderWorkspace() {
    const session = selectedSession();
    $("workspace-empty").hidden = Boolean(session);
    $("session-workspace").hidden = !session;
    if (!session) {
      const sourceError = state.data?.source?.health === "error"
        ? text(state.data?.warnings?.[0], "Локальный источник данных недоступен.") : null;
      $("empty-message").textContent = state.error || sourceError || (state.data
        ? "Откройте локальный чат в Codex. Доступные сессии появятся автоматически."
        : "Читаем локальные сессии Codex.");
      return;
    }
    $("session-workspace").dataset.sessionId = session.id;
    $("session-title").textContent = text(session.title, "Сессия без названия");
    $("session-title").title = text(session.title);
    renderStatus($("session-status"), session);
    $("current-scope").textContent = session.status === "active" ? "Этот ход" : "Последний ход";
    document.querySelectorAll("[data-scope]").forEach((button) => {
      const selected = (button.dataset.scope === "history") === state.history;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    const rows = skillRows(session);
    renderSkills(session, rows);
  }

  function renderSkills(session, rows) {
    const query = state.skillQuery.trim().toLocaleLowerCase("ru-RU");
    const filtered = rows.filter((skill) => [skillName(skill), skill.description, skill.path]
      .join(" ").toLocaleLowerCase("ru-RU").includes(query));
    const signature = JSON.stringify([session.id, filtered, state.history, query]);
    if (signature === state.signatures.skills) return;
    state.signatures.skills = signature;
    const fragment = document.createDocumentFragment();
    for (const skill of filtered) {
      const row = element("tr", skill.signals.length ? "has-signals" : "");
      row.dataset.skillName = skillName(skill);
      row.dataset.loaded = String(skill.loaded);
      row.dataset.declared = String(skill.declared);
      const identity = element("td");
      const name = element("span", "skill-name", skillName(skill));
      name.title = text(skill.description) || text(skill.path) || skillName(skill);
      identity.append(name);
      const status = element("td");
      const labels = element("div", "skill-states");
      if (skill.loaded) labels.append(element("span", "skill-state loaded", "Прочитан"));
      if (skill.declared) labels.append(element("span", "skill-state declared", "Заявлен"));
      if (!skill.loaded && !skill.declared) labels.append(element("span", "skill-state", skill.available ? "Доступен" : "Сигнал"));
      status.append(labels);
      row.append(identity, status);
      fragment.append(row);
    }
    $("skill-rows").replaceChildren(fragment);
    $("skills-empty").hidden = filtered.length > 0;
    $("skills-empty").textContent = query ? "Скиллы не найдены" : "Скиллов пока нет";
  }

  function renderWidget(force = false) {
    if (!isWidget()) return;
    const session = selectedWidgetSession();
    const connection = connectionState();
    const signature = JSON.stringify([session, state.data?.window, connection.unavailable,
      connection.stale, state.data?.generatedAt]);
    if (!force && signature === state.signatures.widget) return;
    state.signatures.widget = signature;
    const fragment = document.createDocumentFragment();
    const header = element("header", "widget-header");
    const identity = element("div", "widget-identity");
    const title = element("h1", "widget-title", session ? text(session.title, "Сессия") : "Сессия недоступна");
    title.title = session ? text(session.title) : "Сессии нет в текущем снимке";
    identity.append(title);
    const controls = element("div", "widget-controls");
    const pinned = Boolean(state.data?.window?.alwaysOnTop);
    const pin = iconButton("pin", pinned ? "Открепить поверх окон" : "Поверх всех окон",
      togglePin, "widget:pin", pinned ? "pinned" : "");
    pin.setAttribute("aria-pressed", String(pinned));
    controls.append(iconButton("overview", "Открыть обзор", () => windowAction("overview"), "widget:overview"),
      pin, iconButton("close", "Закрыть виджет", () => windowAction("close"), "widget:close", "close-window"));
    header.append(identity, controls);
    fragment.append(header);
    if (session) {
      const status = element("div", "widget-status");
      const label = element("span");
      renderStatus(label, session);
      status.append(label);
      fragment.append(status);
    }
    const skills = element("section", "widget-skills");
    const sectionHeading = element("p", "widget-section-heading");
    sectionHeading.textContent = session?.status === "active" ? "Этот ход" : "Последний ход";
    skills.append(sectionHeading);
    const activeSkills = session ? skillRows(session, false).filter((skill) => skill.signals.length) : [];
    const names = element("div", "widget-skill-list");
    names.id = "widget-skill-list";
    for (const skill of activeSkills.slice(0, 3)) {
      const row = element("div", "widget-skill");
      row.dataset.skillName = skillName(skill);
      const name = element("span", "widget-skill-name", skillName(skill));
      name.title = skillName(skill);
      const pills = element("span", "widget-pills");
      if (skill.loaded) pills.append(element("span", "widget-pill loaded", "Прочитан"));
      if (skill.declared) pills.append(element("span", "widget-pill declared", "Заявлен"));
      if (!skill.loaded && !skill.declared) pills.append(element("span", "widget-pill", "Сигнал"));
      row.append(name, pills);
      names.append(row);
    }
    skills.append(names);
    if (activeSkills.length > 3) {
      const more = element("button", "widget-more", `Ещё ${activeSkills.length - 3}`);
      more.dataset.focusKey = "widget:more";
      more.addEventListener("click", () => windowAction("overview"));
      skills.append(more);
    }
    if (!activeSkills.length) skills.append(element("p", "widget-empty", session
      ? "Действий со скиллами пока нет"
      : "Сессия недоступна"));
    fragment.append(skills);
    if (connection.unavailable || connection.stale) fragment.append(element("p", "widget-notice",
      connection.unavailable ? "Источник недоступен" : "Данные устарели"));
    replaceContent($("widget"), fragment);
    document.title = session ? `${text(session.title, "Сессия")} — Skill Desk` : "Skill Desk";
  }

  function openSource() {
    renderConnection();
    if (!$("source-dialog").open) $("source-dialog").showModal();
  }

  function render() {
    const widget = isWidget();
    document.body.classList.toggle("desktop", Boolean(native));
    document.body.classList.toggle("widget-mode", widget);
    $("overview").hidden = widget;
    $("widget").hidden = !widget;
    applyPreferences();
    renderConnection();
    if (widget) renderWidget();
    else {
      renderSessions();
      renderWorkspace();
    }
  }

  async function refresh(initial = false) {
    if (state.loading) return;
    state.loading = true;
    $("refresh-button").disabled = true;
    $("refresh-button").classList.add("refreshing");
    try {
      if (native) receive(await (initial ? native.getSnapshot() : native.refresh()));
      else {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch("/api/state", {
            cache: "no-store", signal: controller.signal,
            headers: { Accept: "application/json" },
          });
          if (!response.ok) throw new Error(`Источник ответил HTTP ${response.status}`);
          receive(await response.json());
        } finally { clearTimeout(timeout); }
      }
    } catch (error) {
      state.error = error?.name === "AbortError" ? "Источник не ответил за 8 секунд" : errorMessage(error);
      render();
    } finally {
      state.loading = false;
      $("refresh-button").disabled = false;
      $("refresh-button").classList.remove("refreshing");
    }
  }

  document.querySelectorAll("[data-icon]").forEach((node) => node.append(icon(node.dataset.icon)));
  document.querySelectorAll("[data-window]").forEach((button) =>
    button.addEventListener("click", () => windowAction(button.dataset.window)));
  document.querySelectorAll("[data-close]").forEach((button) =>
    button.addEventListener("click", () => button.closest("dialog").close()));
  $("source-dialog").addEventListener("click", (event) => {
    if (event.target !== $("source-dialog")) return;
    const rect = $("source-dialog").getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right
      || event.clientY < rect.top || event.clientY > rect.bottom) $("source-dialog").close();
  });
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      renderSessions();
    });
  });
  $("session-search").addEventListener("input", (event) => {
    state.sessionQuery = event.target.value;
    renderSessions();
  });
  $("skill-search").addEventListener("input", (event) => {
    state.skillQuery = event.target.value;
    renderWorkspace();
  });
  document.querySelectorAll("[data-scope]").forEach((button) => button.addEventListener("click", () => {
    state.history = button.dataset.scope === "history";
    renderWorkspace();
  }));
  $("theme-button").addEventListener("click", () =>
    setPreferences({ theme: state.preferences.theme === "light" ? "dark" : "light" }));
  $("subagents").addEventListener("change", (event) =>
    setPreferences({ showSubagents: event.target.checked }));
  $("refresh-button").addEventListener("click", () => refresh());
  $("popout-button").addEventListener("click", openWidget);
  $("settings-button").addEventListener("click", openSource);

  if (native) {
    native.onUpdate((data) => {
      try { receive(data); }
      catch (error) { state.error = errorMessage(error); renderConnection(); }
    });
    native.onNotice((notice) => toast(typeof notice === "string" ? notice : notice?.message));
  } else {
    try {
      const saved = JSON.parse(localStorage.getItem("skill-desk:preferences") || "null");
      if (saved && typeof saved === "object") {
        state.preferences.theme = saved.theme === "light" ? "light" : "dark";
        state.preferences.showSubagents = saved.showSubagents === true;
      }
    } catch { /* Browser storage is optional. */ }
  }
  render();
  refresh(true);
  if (!native) setInterval(() => refresh(), 3000);
  setInterval(render, 15000);
})();
