use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub const MAX_WIDGETS: usize = 32;

pub fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= 240 && !id.chars().any(char::is_control)
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DisplayArea {
    /// Global physical coordinates of the display's usable work area.
    pub bounds: Bounds,
    pub scale: f64,
}

pub fn valid_bounds(value: &Value) -> Option<Bounds> {
    let b: Bounds = serde_json::from_value(value.clone()).ok()?;
    if ![b.x, b.y, b.width, b.height].iter().all(|x| x.is_finite())
        || !(100.0..=20000.0).contains(&b.width)
        || !(80.0..=20000.0).contains(&b.height)
        || b.x.abs() > 100000.0
        || b.y.abs() > 100000.0
    {
        return None;
    }
    Some(Bounds {
        x: b.x.round(),
        y: b.y.round(),
        width: b.width.round(),
        height: b.height.round(),
    })
}

pub fn normalize(input: &Value) -> Value {
    let p = &input["preferences"];
    let theme = p["theme"]
        .as_str()
        .filter(|x| ["dark", "light"].contains(x))
        .unwrap_or("dark");
    let view = p["view"]
        .as_str()
        .filter(|x| ["grid", "list"].contains(x))
        .unwrap_or("grid");
    let mut widgets = Map::new();
    if let Some(values) = input["widgets"].as_object() {
        for (id, saved) in values
            .iter()
            .filter(|(id, v)| valid_session_id(id) && v.is_object())
            .take(MAX_WIDGETS)
        {
            let mut widget = json!({"bounds": valid_bounds(&saved["bounds"]),
                "alwaysOnTop": saved["alwaysOnTop"] != false, "open": saved["open"] == true});
            if saved["positionSpace"] == "physical" {
                widget["positionSpace"] = json!("physical");
            }
            widgets.insert(id.clone(), widget);
        }
    }
    let mut result = json!({"version": 1, "preferences": {"theme": theme, "view": view,
        "showSubagents": p["showSubagents"] == true},
        "overview": {"bounds": valid_bounds(&input["overview"]["bounds"]),
            "alwaysOnTop": input["overview"]["alwaysOnTop"] == true}, "widgets": widgets});
    if input["overview"]["positionSpace"] == "physical" {
        result["overview"]["positionSpace"] = json!("physical");
    }
    result
}

pub fn validate_preferences(update: &Value) -> Result<(), String> {
    let values = update.as_object().ok_or("Некорректные настройки.")?;
    for (key, value) in values {
        let valid = match key.as_str() {
            "theme" => value
                .as_str()
                .is_some_and(|x| ["dark", "light"].contains(&x)),
            "view" => value
                .as_str()
                .is_some_and(|x| ["grid", "list"].contains(&x)),
            "showSubagents" => value.is_boolean(),
            _ => false,
        };
        if !valid {
            return Err("Неизвестная или некорректная настройка.".into());
        }
    }
    Ok(())
}

/// Saved coordinates use logical pixels, independently of each display's scale.
pub fn clamp_bounds(saved: Option<Bounds>, areas: &[Bounds], widget: bool) -> Bounds {
    let (dw, dh, mw, mh) = if widget {
        (400.0, 300.0, 330.0, 230.0)
    } else {
        (1100.0, 790.0, 660.0, 500.0)
    };
    let fallback = Bounds {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };
    let overlap = |area: &&Bounds| {
        saved
            .map(|b| {
                ((b.x + b.width).min(area.x + area.width) - b.x.max(area.x)).max(0.0)
                    * ((b.y + b.height).min(area.y + area.height) - b.y.max(area.y)).max(0.0)
            })
            .unwrap_or(0.0)
    };
    let mut area = areas.first().unwrap_or(&fallback);
    for candidate in areas.iter().skip(1) {
        // The first display is the primary display. Keep it on ties, including
        // a new window or saved coordinates from a disconnected monitor.
        if overlap(&candidate) > overlap(&area) {
            area = candidate;
        }
    }
    let width = saved.map_or(dw, |b| b.width).max(mw).min(area.width);
    let height = saved.map_or(dh, |b| b.height).max(mh).min(area.height);
    let (x, y) = if overlap(&area) > 0.0 {
        (saved.unwrap().x, saved.unwrap().y)
    } else {
        (
            area.x + (area.width - width) / 2.0,
            area.y + (area.height - height) / 2.0,
        )
    };
    Bounds {
        x: x.clamp(area.x, area.x + area.width - width).round(),
        y: y.clamp(area.y, area.y + area.height - height).round(),
        width,
        height,
    }
}

/// Return global physical x/y and logical width/height. Keeping global window
/// coordinates physical avoids overlapping coordinate ranges on mixed-DPI
/// displays; window dimensions still keep their perceived logical size.
pub fn place_window(
    saved: Option<Bounds>,
    physical_position: bool,
    displays: &[DisplayArea],
    widget: bool,
) -> Bounds {
    let fallback = DisplayArea {
        bounds: Bounds {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        },
        scale: 1.0,
    };
    let displays = if displays.is_empty() {
        std::slice::from_ref(&fallback)
    } else {
        displays
    };

    if !physical_position {
        if let Some(saved) = saved {
            let logical: Vec<Bounds> = displays
                .iter()
                .map(|display| Bounds {
                    x: display.bounds.x / display.scale,
                    y: display.bounds.y / display.scale,
                    width: display.bounds.width / display.scale,
                    height: display.bounds.height / display.scale,
                })
                .collect();
            let overlap = |area: &Bounds| intersection(saved, *area);
            let mut chosen = 0;
            for index in 1..logical.len() {
                if overlap(&logical[index]) > overlap(&logical[chosen]) {
                    chosen = index;
                }
            }
            let legacy = clamp_bounds(Some(saved), &logical, widget);
            let converted = Bounds {
                x: legacy.x * displays[chosen].scale,
                y: legacy.y * displays[chosen].scale,
                width: legacy.width,
                height: legacy.height,
            };
            return place_window(Some(converted), true, displays, widget);
        }
    }

    let overlap = |display: &DisplayArea| {
        saved
            .map(|saved| {
                intersection(
                    Bounds {
                        x: saved.x,
                        y: saved.y,
                        width: saved.width * display.scale,
                        height: saved.height * display.scale,
                    },
                    display.bounds,
                )
            })
            .unwrap_or(0.0)
    };
    let mut display = &displays[0];
    for candidate in displays.iter().skip(1) {
        if overlap(candidate) > overlap(display) {
            display = candidate;
        }
    }
    let area = display.bounds;
    let (default_width, default_height, minimum_width, minimum_height) = if widget {
        (400.0, 300.0, 330.0, 230.0)
    } else {
        (1100.0, 790.0, 660.0, 500.0)
    };
    let width = saved
        .map_or(default_width, |bounds| bounds.width)
        .max(minimum_width)
        .min(area.width / display.scale);
    let height = saved
        .map_or(default_height, |bounds| bounds.height)
        .max(minimum_height)
        .min(area.height / display.scale);
    let physical_width = width * display.scale;
    let physical_height = height * display.scale;
    let (x, y) = if overlap(display) > 0.0 {
        let saved = saved.expect("overlap requires saved coordinates");
        (saved.x, saved.y)
    } else {
        (
            area.x + (area.width - physical_width) / 2.0,
            area.y + (area.height - physical_height) / 2.0,
        )
    };
    Bounds {
        x: x.clamp(area.x, (area.x + area.width - physical_width).max(area.x))
            .round(),
        y: y.clamp(area.y, (area.y + area.height - physical_height).max(area.y))
            .round(),
        width,
        height,
    }
}

fn intersection(window: Bounds, area: Bounds) -> f64 {
    ((window.x + window.width).min(area.x + area.width) - window.x.max(area.x)).max(0.0)
        * ((window.y + window.height).min(area.y + area.height) - window.y.max(area.y)).max(0.0)
}

pub struct StateStore {
    pub directory: PathBuf,
}

impl StateStore {
    pub fn new(directory: PathBuf) -> Result<Self, String> {
        if !directory.is_absolute() {
            return Err("SKILL_DESK_PROFILE должен быть абсолютным путём.".into());
        }
        if directory.components().any(|x| {
            x.as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(".codex")
        }) {
            return Err("Профиль приложения должен находиться вне служебной папки Codex.".into());
        }
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        Ok(Self { directory })
    }

    pub fn load(&self) -> Result<Value, String> {
        match fs::read(self.directory.join("desktop-state.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(|v| normalize(&v))
                .map_err(|e| e.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(normalize(&Value::Null)),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn save(&self, state: &Value) -> Result<(), String> {
        let temp = self
            .directory
            .join(format!(".desktop-state-{}.tmp", std::process::id()));
        let operation = || -> Result<(), Box<dyn std::error::Error>> {
            let mut file = fs::File::create(&temp)?;
            file.write_all(&serde_json::to_vec_pretty(&normalize(state))?)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temp, self.directory.join("desktop-state.json"))?;
            Ok(())
        };
        let result = operation().map_err(|_| {
            "Не удалось сохранить настройки окон. Проверьте доступ к папке приложения.".to_string()
        });
        if temp.exists() {
            let _ = fs::remove_file(&temp);
        }
        result
    }
}

pub fn profile_directory() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("SKILL_DESK_PROFILE") {
        return Ok(PathBuf::from(path));
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("XDG_DATA_HOME"))
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| Path::new(&p).join(".local/share")))
        .ok_or("Не удалось определить папку настроек приложения.")?;
    Ok(base.join("Skill Desk"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mixed_displays() -> [DisplayArea; 2] {
        [
            DisplayArea {
                bounds: Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 1920.0,
                    height: 1040.0,
                },
                scale: 1.0,
            },
            DisplayArea {
                bounds: Bounds {
                    x: 1920.0,
                    y: 0.0,
                    width: 2560.0,
                    height: 1400.0,
                },
                scale: 1.5,
            },
        ]
    }

    #[test]
    fn new_windows_and_disconnected_windows_use_first_display() {
        let displays = mixed_displays();
        let expected = Bounds {
            x: 760.0,
            y: 370.0,
            width: 400.0,
            height: 300.0,
        };
        assert_eq!(place_window(None, true, &displays, true), expected);
        assert_eq!(place_window(None, false, &displays, true), expected);
        let disconnected = Bounds {
            x: 9000.0,
            y: 100.0,
            width: 400.0,
            height: 300.0,
        };
        assert_eq!(
            place_window(Some(disconnected), true, &displays, true),
            expected
        );
        assert_eq!(
            place_window(Some(disconnected), false, &displays, true),
            expected
        );
        let areas: Vec<Bounds> = displays.iter().map(|display| display.bounds).collect();
        assert_eq!(clamp_bounds(None, &areas, true), expected);
        assert_eq!(clamp_bounds(Some(disconnected), &areas, true), expected);
    }

    #[test]
    fn physical_position_stays_on_second_display_with_mixed_dpi() {
        let displays = mixed_displays();
        let saved = Bounds {
            x: 2250.0,
            y: 200.0,
            width: 400.0,
            height: 300.0,
        };
        let restored = place_window(Some(saved), true, &displays, true);
        assert_eq!(restored, saved);
        assert!(restored.x >= 1920.0);
        assert!(restored.x + restored.width * displays[1].scale <= 4480.0);
        assert_eq!(
            place_window(Some(restored), true, &displays, true),
            restored
        );
    }

    #[test]
    fn physical_restore_clamps_logical_dimensions_to_scaled_work_area() {
        let displays = mixed_displays();
        let restored = place_window(
            Some(Bounds {
                x: 2250.0,
                y: 200.0,
                width: 4000.0,
                height: 3000.0,
            }),
            true,
            &displays,
            false,
        );
        assert_eq!(restored.x, 1920.0);
        assert_eq!(restored.y, 0.0);
        assert_eq!(restored.width, displays[1].bounds.width / displays[1].scale);
        assert_eq!(
            restored.height,
            displays[1].bounds.height / displays[1].scale
        );
    }

    #[test]
    fn legacy_logical_positions_are_converted_before_physical_restore() {
        let restored = place_window(
            Some(Bounds {
                x: 2000.0,
                y: 200.0,
                width: 400.0,
                height: 300.0,
            }),
            false,
            &mixed_displays(),
            true,
        );
        assert_eq!(
            restored,
            Bounds {
                x: 3000.0,
                y: 300.0,
                width: 400.0,
                height: 300.0
            }
        );
    }

    #[test]
    fn normalizer_preserves_physical_position_marker_without_changing_legacy_shapes() {
        let legacy = normalize(&json!({"widgets":{"legacy":{"open":true}}}));
        assert!(legacy["overview"].get("positionSpace").is_none());
        assert!(legacy["widgets"]["legacy"].get("positionSpace").is_none());
        let saved = normalize(&json!({
            "overview":{"positionSpace":"physical"},
            "widgets":{"physical":{"positionSpace":"physical"}, "bad":{"positionSpace":"unknown"}},
        }));
        assert_eq!(saved["overview"]["positionSpace"], "physical");
        assert_eq!(saved["widgets"]["physical"]["positionSpace"], "physical");
        assert!(saved["widgets"]["bad"].get("positionSpace").is_none());
        assert_eq!(normalize(&saved), saved);
    }

    #[test]
    fn validates_preferences_and_caps_widget_restore() {
        let mut input = json!({"preferences":{"theme":"bad", "showSubagents":"yes"},"widgets":{}});
        for n in 0..100 {
            input["widgets"][format!("s{n}")] = json!({"open":true});
        }
        let result = normalize(&input);
        assert_eq!(
            result["preferences"],
            json!({"theme":"dark","view":"grid","showSubagents":false})
        );
        assert_eq!(result["widgets"].as_object().unwrap().len(), 32);
        for update in [
            Value::Null,
            json!([]),
            json!({"theme":"auto"}),
            json!({"profile":"x"}),
            json!({"showSubagents":"yes"}),
        ] {
            assert!(validate_preferences(&update).is_err());
        }
        assert!(validate_preferences(&json!({"theme":"light","showSubagents":true})).is_ok());
    }
    #[test]
    fn restores_inside_connected_display() {
        let area = Bounds {
            x: 0.0,
            y: 0.0,
            width: 1280.0,
            height: 720.0,
        };
        let result = clamp_bounds(
            Some(Bounds {
                x: 3900.0,
                y: -100.0,
                width: 1600.0,
                height: 900.0,
            }),
            &[area],
            false,
        );
        assert_eq!(result, area);
        let result = clamp_bounds(
            Some(Bounds {
                x: -1700.0,
                y: 800.0,
                width: 400.0,
                height: 360.0,
            }),
            &[
                Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 1920.0,
                    height: 1040.0,
                },
                Bounds {
                    x: -1600.0,
                    y: 0.0,
                    width: 1600.0,
                    height: 900.0,
                },
            ],
            true,
        );
        assert_eq!(
            result,
            Bounds {
                x: -1600.0,
                y: 540.0,
                width: 400.0,
                height: 360.0
            }
        );
    }
    #[test]
    fn saves_existing_state_atomically_and_preserves_unrelated_files() {
        let directory = tempfile::tempdir().unwrap();
        let store = StateStore::new(directory.path().to_owned()).unwrap();
        fs::write(directory.path().join("unrelated.txt"), "untouched").unwrap();
        let mut state = store.load().unwrap();
        state["preferences"]["theme"] = json!("light");
        store.save(&state).unwrap();
        state["widgets"]["session"] = json!({"open":true,"alwaysOnTop":false,"bounds":null});
        store.save(&state).unwrap();
        assert_eq!(store.load().unwrap(), state);
        assert_eq!(
            fs::read_to_string(directory.path().join("unrelated.txt")).unwrap(),
            "untouched"
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
    }
    #[test]
    fn rejects_codex_profile_and_control_characters() {
        assert!(!valid_session_id("x\n"));
        assert!(StateStore::new(PathBuf::from("relative")).is_err());
        let root = tempfile::tempdir().unwrap();
        assert!(StateStore::new(root.path().join(".CoDeX/profile")).is_err());
    }
}
