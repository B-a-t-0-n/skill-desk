use crate::{
    monitor::Monitor,
    state::{self, Bounds, DisplayArea, StateStore, MAX_WIDGETS},
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

struct Desktop {
    saved: Value,
    last_saved: Value,
    provider: Value,
    bindings: HashMap<String, String>,
    opening: HashSet<String>,
    storage_error: Option<String>,
}

struct AppState {
    monitor: Mutex<Monitor>,
    desktop: Mutex<Desktop>,
    store: StateStore,
    quitting: AtomicBool,
    next_widget: AtomicU64,
}

#[derive(Debug, PartialEq)]
enum WidgetReservation {
    Existing(String),
    Pending,
    Create,
}

// Reserve the session and one slot under the same mutex, then release it before
// constructing WebView2. Its callbacks must be able to acquire application state.
fn reserve_widget(desktop: &mut Desktop, id: &str) -> Result<WidgetReservation, String> {
    if !state::valid_session_id(id)
        || !desktop.provider["sessions"]
            .as_array()
            .is_some_and(|sessions| sessions.iter().any(|s| s["id"] == id))
    {
        return Err("Сессия не найдена. Обновите список.".into());
    }
    if let Some((label, _)) = desktop.bindings.iter().find(|(_, session)| *session == id) {
        return Ok(WidgetReservation::Existing(label.clone()));
    }
    if desktop.opening.contains(id) {
        return Ok(WidgetReservation::Pending);
    }
    let pending = desktop
        .opening
        .iter()
        .filter(|id| !desktop.bindings.values().any(|session| session == *id))
        .count();
    if desktop.bindings.len() + pending >= MAX_WIDGETS {
        return Err("Открыто слишком много виджетов. Закройте один из них.".into());
    }
    desktop.opening.insert(id.to_owned());
    Ok(WidgetReservation::Create)
}

fn save_locked(state: &AppState, desktop: &mut Desktop) -> Result<(), String> {
    if desktop.saved == desktop.last_saved && desktop.storage_error.is_none() {
        return Ok(());
    }
    match state.store.save(&desktop.saved) {
        Ok(()) => {
            desktop.last_saved = desktop.saved.clone();
            desktop.storage_error = None;
            Ok(())
        }
        Err(error) => {
            desktop.storage_error = Some(error.clone());
            Err(error)
        }
    }
}

fn snapshot(app: &AppHandle, window: &WebviewWindow) -> Value {
    let state = app.state::<AppState>();
    let (mut result, id, preferences, widgets, error) = {
        let desktop = state.desktop.lock().unwrap();
        (
            desktop.provider.clone(),
            desktop.bindings.get(window.label()).cloned(),
            desktop.saved["preferences"].clone(),
            desktop.bindings.values().cloned().collect::<Vec<_>>(),
            desktop.storage_error.clone(),
        )
    };
    result["desktop"] = json!(true);
    result["preferences"] = preferences;
    result["widgets"] = json!(widgets);
    result["window"] = json!({"kind": if id.is_some() {"widget"} else {"overview"},
        "sessionId": id, "alwaysOnTop": window.is_always_on_top().unwrap_or(false)});
    if let Some(error) = error {
        if let Some(warnings) = result["warnings"].as_array_mut() {
            warnings.push(json!(error));
        }
    }
    result
}

fn broadcast(app: &AppHandle) {
    for window in app.webview_windows().values() {
        let _ = app.emit_to(window.label(), "skill-desk:update", snapshot(app, window));
    }
}

fn refresh_data(app: &AppHandle) {
    let state = app.state::<AppState>();
    let provider = state.monitor.lock().unwrap().get_state();
    {
        let mut desktop = state.desktop.lock().unwrap();
        desktop.provider = provider;
        let _ = save_locked(&state, &mut desktop);
    }
    broadcast(app);
}

fn show_overview(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("overview") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn capture_bounds(window: &WebviewWindow) {
    if window.is_minimized().unwrap_or(false) || window.is_maximized().unwrap_or(false) {
        return;
    }
    let (Ok(position), Ok(size), Ok(scale)) = (
        window.outer_position(),
        window.inner_size(),
        window.scale_factor(),
    ) else {
        return;
    };
    let size = size.to_logical::<f64>(scale);
    let bounds = Bounds {
        x: position.x as f64,
        y: position.y as f64,
        width: size.width,
        height: size.height,
    };
    let app = window.app_handle();
    let always_on_top = window.is_always_on_top().unwrap_or(false);
    let state = app.state::<AppState>();
    let mut desktop = state.desktop.lock().unwrap();
    let key = desktop.bindings.get(window.label()).cloned();
    let target = if let Some(id) = key {
        &mut desktop.saved["widgets"][id]
    } else {
        &mut desktop.saved["overview"]
    };
    target["bounds"] = json!(bounds);
    target["positionSpace"] = json!("physical");
    target["alwaysOnTop"] = json!(always_on_top);
}

fn display_areas(app: &AppHandle) -> Vec<DisplayArea> {
    let primary = app.primary_monitor().ok().flatten().map(|m| *m.position());
    let mut monitors = app.available_monitors().unwrap_or_default();
    monitors.sort_by_key(|m| if Some(*m.position()) == primary { 0 } else { 1 });
    monitors
        .iter()
        .map(|m| {
            let area = m.work_area();
            DisplayArea {
                bounds: Bounds {
                    x: area.position.x as f64,
                    y: area.position.y as f64,
                    width: area.size.width as f64,
                    height: area.size.height as f64,
                },
                scale: m.scale_factor(),
            }
        })
        .collect()
}

fn create_window(app: &AppHandle, id: Option<String>) -> Result<WebviewWindow, String> {
    let widget = id.is_some();
    let state = app.state::<AppState>();
    let (saved, theme, label) = {
        let desktop = state.desktop.lock().unwrap();
        let saved = id
            .as_ref()
            .map(|id| desktop.saved["widgets"][id].clone())
            .unwrap_or_else(|| desktop.saved["overview"].clone());
        let label = if widget {
            format!(
                "widget-{}",
                state.next_widget.fetch_add(1, Ordering::Relaxed)
            )
        } else {
            "overview".into()
        };
        (
            saved,
            desktop.saved["preferences"]["theme"]
                .as_str()
                .unwrap_or("dark")
                .to_owned(),
            label,
        )
    };
    let bounds = state::place_window(
        state::valid_bounds(&saved["bounds"]),
        saved["positionSpace"] == "physical",
        &display_areas(app),
        widget,
    );
    let mut url = "index.html".to_string();
    if let Some(id) = &id {
        let query: String = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("widget", id)
            .finish();
        url.push('?');
        url.push_str(&query);
    }
    let profile = state.store.directory.join("webview");
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title(if widget {
            "Skill Desk · Сессия"
        } else {
            "Skill Desk"
        })
        .decorations(false)
        .visible(false)
        .resizable(true)
        .inner_size(bounds.width, bounds.height)
        .min_inner_size(
            if widget {
                330.0_f64.min(bounds.width)
            } else {
                660.0_f64.min(bounds.width)
            },
            if widget {
                230.0_f64.min(bounds.height)
            } else {
                500.0_f64.min(bounds.height)
            },
        )
        .always_on_top(if widget {
            saved["alwaysOnTop"] != false
        } else {
            saved["alwaysOnTop"] == true
        })
        .data_directory(profile)
        .theme(Some(if theme == "light" {
            tauri::Theme::Light
        } else {
            tauri::Theme::Dark
        }))
        .on_navigation(|url| {
            (url.scheme() == "tauri"
                || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost")))
                && ["/", "/index.html"].contains(&url.path())
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone()).map_err(|e| e.to_string())?;
    }
    // Debug-only opt-in CDP endpoint allows end-to-end checks against the actual WebView2.
    #[cfg(debug_assertions)]
    if std::env::var("SKILL_DESK_TEST").as_deref() == Ok("1") {
        builder = builder.additional_browser_args("--remote-debugging-port=47835");
    }
    // The webview may request its initial snapshot during build(), before it
    // returns. Register its identity first so it can never receive overview data.
    if let Some(id) = &id {
        state
            .desktop
            .lock()
            .unwrap()
            .bindings
            .insert(label.clone(), id.clone());
    }
    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            state.desktop.lock().unwrap().bindings.remove(&label);
            return Err(error.to_string());
        }
    };
    window
        .set_position(tauri::PhysicalPosition::new(
            bounds.x as i32,
            bounds.y as i32,
        ))
        .map_err(|e| e.to_string())?;
    let event_window = window.clone();
    window.on_window_event(move |event| {
        let app = event_window.app_handle();
        let state = app.state::<AppState>();
        match event {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => capture_bounds(&event_window),
            WindowEvent::CloseRequested { api, .. } => {
                capture_bounds(&event_window);
                let mut desktop = state.desktop.lock().unwrap();
                if !state.quitting.load(Ordering::Relaxed) {
                    if event_window.label() == "overview" {
                        api.prevent_close();
                        let _ = event_window.hide();
                    } else if let Some(id) = desktop.bindings.get(event_window.label()).cloned() {
                        desktop.saved["widgets"][id]["open"] = json!(false);
                    }
                }
                let _ = save_locked(&state, &mut desktop);
            }
            WindowEvent::Destroyed => {
                state
                    .desktop
                    .lock()
                    .unwrap()
                    .bindings
                    .remove(event_window.label());
                broadcast(app);
            }
            _ => {}
        }
    });
    if !cfg!(debug_assertions) || std::env::var("SKILL_DESK_TEST").as_deref() != Ok("1") {
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(window)
}

fn quit(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.quitting.store(true, Ordering::Relaxed);
    for window in app.webview_windows().values() {
        capture_bounds(window);
    }
    let _ = save_locked(&state, &mut state.desktop.lock().unwrap());
    app.exit(0);
}

#[tauri::command]
fn get_snapshot(app: AppHandle, window: WebviewWindow) -> Value {
    snapshot(&app, &window)
}

#[tauri::command]
async fn refresh(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || refresh_data(&handle))
        .await
        .map_err(|e| e.to_string())?;
    Ok(snapshot(&app, &window))
}

#[tauri::command]
async fn open_widget(
    app: AppHandle,
    window: WebviewWindow,
    session_id: String,
) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let reservation = reserve_widget(&mut state.desktop.lock().unwrap(), &session_id)?;
    if let WidgetReservation::Existing(ref label) = reservation {
        if let Some(existing) = app.get_webview_window(label) {
            let _ = existing.unminimize();
            let _ = existing.show();
            let _ = existing.set_focus();
        }
    } else if reservation == WidgetReservation::Create {
        let result = create_window(&app, Some(session_id.clone()));
        let created;
        {
            let mut desktop = state.desktop.lock().unwrap();
            desktop.opening.remove(&session_id);
            created = result?;
            if desktop.saved["widgets"].get(&session_id).is_none()
                && desktop.saved["widgets"].as_object().unwrap().len() >= MAX_WIDGETS
            {
                let old = desktop.saved["widgets"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .find(|(id, _)| {
                        !desktop.bindings.values().any(|session| session == *id)
                            && !desktop.opening.contains(*id)
                    })
                    .map(|(id, _)| id.clone());
                if let Some(old) = old {
                    desktop.saved["widgets"]
                        .as_object_mut()
                        .unwrap()
                        .remove(&old);
                }
            }
            if desktop.saved["widgets"].get(&session_id).is_none() {
                desktop.saved["widgets"][&session_id] = json!({"bounds":null,"alwaysOnTop":true});
            }
            desktop.saved["widgets"][&session_id]["open"] = json!(true);
        }
        capture_bounds(&created);
        let _ = save_locked(&state, &mut state.desktop.lock().unwrap());
        broadcast(&app);
    }
    Ok(snapshot(&app, &window))
}

#[tauri::command]
fn set_always_on_top(app: AppHandle, window: WebviewWindow, value: bool) -> Result<Value, String> {
    window.set_always_on_top(value).map_err(|e| e.to_string())?;
    capture_bounds(&window);
    let state = app.state::<AppState>();
    {
        let mut desktop = state.desktop.lock().unwrap();
        let id = desktop.bindings.get(window.label()).cloned();
        let saved = if let Some(id) = id {
            &mut desktop.saved["widgets"][id]
        } else {
            &mut desktop.saved["overview"]
        };
        saved["alwaysOnTop"] = json!(value);
        save_locked(&state, &mut desktop)?;
    }
    broadcast(&app);
    Ok(snapshot(&app, &window))
}

#[tauri::command]
fn set_preferences(app: AppHandle, window: WebviewWindow, patch: Value) -> Result<Value, String> {
    state::validate_preferences(&patch)?;
    let state = app.state::<AppState>();
    {
        let mut desktop = state.desktop.lock().unwrap();
        let mut next = desktop.saved.clone();
        for (key, value) in patch.as_object().unwrap() {
            next["preferences"][key] = value.clone();
        }
        state.store.save(&next)?;
        desktop.last_saved = next.clone();
        desktop.saved = next;
        desktop.storage_error = None;
    }
    broadcast(&app);
    Ok(snapshot(&app, &window))
}

#[tauri::command]
async fn window_action(
    app: AppHandle,
    window: WebviewWindow,
    action: String,
) -> Result<Value, String> {
    let result = snapshot(&app, &window);
    match action.as_str() {
        "minimize" => window.minimize().map_err(|e| e.to_string())?,
        "close" => window.close().map_err(|e| e.to_string())?,
        "overview" => show_overview(&app),
        "quit" => quit(&app),
        "drag" => window.start_dragging().map_err(|e| e.to_string())?,
        _ => return Err("Неизвестное действие окна.".into()),
    }
    Ok(result)
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let store = StateStore::new(state::profile_directory()?)?;
    let (saved, storage_error) = match store.load() {
        Ok(saved) => (saved, None),
        Err(_) => (
            state::normalize(&Value::Null),
            Some(
                "Не удалось прочитать настройки окон. Используются настройки по умолчанию.".into(),
            ),
        ),
    };
    let mut monitor = Monitor::new(None, 80);
    let provider = monitor.get_state();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_overview(app)
        }))
        .manage(AppState {
            monitor: Mutex::new(monitor),
            desktop: Mutex::new(Desktop {
                last_saved: saved.clone(),
                saved,
                provider,
                bindings: HashMap::new(),
                opening: HashSet::new(),
                storage_error,
            }),
            store,
            quitting: AtomicBool::new(false),
            next_widget: AtomicU64::new(1),
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            refresh,
            open_widget,
            set_always_on_top,
            set_preferences,
            window_action
        ])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Открыть Skill Desk", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "Обновить", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let exit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &refresh, &separator, &exit])?;
            TrayIconBuilder::with_id("skill-desk")
                .icon(
                    app.default_window_icon()
                        .ok_or("Иконка приложения не найдена.")?
                        .clone(),
                )
                .tooltip("Skill Desk — скиллы и сессии Codex")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_overview(app),
                    "refresh" => {
                        let app = app.clone();
                        std::thread::spawn(move || refresh_data(&app));
                    }
                    "quit" => quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_overview(tray.app_handle());
                    }
                })
                .build(app)?;
            create_window(app.handle(), None)?;
            let restore = {
                let state = app.state::<AppState>();
                let desktop = state.desktop.lock().unwrap();
                desktop.saved["widgets"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .filter(|(id, v)| {
                        v["open"] == true
                            && desktop.provider["sessions"]
                                .as_array()
                                .is_some_and(|sessions| {
                                    sessions.iter().any(|s| s["id"].as_str() == Some(id))
                                })
                    })
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>()
            };
            for id in restore {
                create_window(app.handle(), Some(id))?;
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(3));
                if handle.state::<AppState>().quitting.load(Ordering::Relaxed) {
                    break;
                }
                refresh_data(&handle);
            });
            Ok(())
        })
        .build(tauri::generate_context!())?;
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() && !app.state::<AppState>().quitting.load(Ordering::Relaxed) {
                api.prevent_exit();
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn desktop() -> Arc<Mutex<Desktop>> {
        Arc::new(Mutex::new(Desktop {
            saved: state::normalize(&Value::Null),
            last_saved: Value::Null,
            provider: json!({"sessions": (0..64).map(|n| json!({"id":format!("session-{n}")})).collect::<Vec<_>>()}),
            bindings: HashMap::new(),
            opening: HashSet::new(),
            storage_error: None,
        }))
    }

    #[test]
    fn concurrent_widget_requests_reserve_only_one_window_and_enforce_the_limit() {
        let state = desktop();
        let handles: Vec<_> = (0..12)
            .map(|_| {
                let state = Arc::clone(&state);
                std::thread::spawn(move || {
                    reserve_widget(&mut state.lock().unwrap(), "session-0").unwrap()
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(
            results
                .iter()
                .filter(|r| **r == WidgetReservation::Create)
                .count(),
            1
        );
        assert_eq!(state.lock().unwrap().opening.len(), 1);

        let state = desktop();
        let handles: Vec<_> = (0..64)
            .map(|n| {
                let state = Arc::clone(&state);
                std::thread::spawn(move || {
                    reserve_widget(&mut state.lock().unwrap(), &format!("session-{n}"))
                })
            })
            .collect();
        let created = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|r| matches!(r, Ok(WidgetReservation::Create)))
            .count();
        assert_eq!(created, MAX_WIDGETS);
        assert_eq!(state.lock().unwrap().opening.len(), MAX_WIDGETS);
    }
}
