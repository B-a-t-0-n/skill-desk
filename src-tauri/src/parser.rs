//! Conservative, read-only interpretation of Codex rollout records.
//! Message, reasoning, command output, and skill contents never leave this module.

use chrono::{DateTime, SecondsFormat, Utc};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

const STALE_MS: i64 = 10 * 60 * 1000;
const MAX_EVENTS: usize = 80;
const MAX_EVIDENCE: usize = 32;

fn re(pattern: &str) -> Arc<Regex> {
    // Rollouts repeat the same catalog and commands thousands of times. Keep
    // compiled patterns across reparses without retaining any message bodies.
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<Regex>>>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(regex) = cache.get(pattern) {
        return Arc::clone(regex);
    }
    // Extremely large or malformed untrusted catalogs must not crash the
    // monitor. A pattern over the engine's size limit establishes no evidence.
    let compiled = Arc::new(
        Regex::new(pattern)
            .unwrap_or_else(|_| Regex::new(r"\b\B").expect("valid fallback pattern")),
    );
    if cache.len() >= 256 {
        cache.clear();
    }
    cache.insert(pattern.to_owned(), Arc::clone(&compiled));
    compiled
}

fn string(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

fn optional_string(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

fn first_string(values: &[&Value]) -> Option<String> {
    values.iter().find_map(|value| optional_string(value))
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64() != Some(0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

fn clean_path(value: &str) -> String {
    let value = value.trim();
    let value = value.strip_prefix(['`', '\'', '"', '“']).unwrap_or(value);
    let mut result = value
        .strip_suffix(['`', '\'', '"', '”'])
        .unwrap_or(value)
        .replace('\\', "/");
    if result
        .get(..7)
        .is_some_and(|v| v.eq_ignore_ascii_case("file://"))
    {
        result = result[7..]
            .strip_prefix('/')
            .unwrap_or(&result[7..])
            .to_owned();
        // Decode file URLs only when the entire percent-encoded path is valid,
        // matching decodeURIComponent's all-or-nothing behavior.
        if let Some(decoded) = percent_decode(&result) {
            result = decoded;
        }
        if !windows_drive(&result) {
            result = format!("/{}", result.trim_start_matches('/'));
        }
    }
    result = result.replace("/./", "/");
    if result.ends_with('/') {
        result.pop();
    }
    result
}

fn percent_decode(value: &str) -> Option<String> {
    let source = value.as_bytes();
    let mut bytes = Vec::with_capacity(source.len());
    let mut i = 0;
    while i < source.len() {
        if source[i] == b'%' {
            let hex = std::str::from_utf8(source.get(i + 1..i + 3)?).ok()?;
            bytes.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            bytes.push(source[i]);
            i += 1;
        }
    }
    String::from_utf8(bytes).ok()
}

fn windows_drive(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
}

fn path_key(value: &str) -> String {
    let normalized = clean_path(value);
    if windows_drive(&normalized) || normalized.starts_with("//") {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn resolve_path(value: &str, cwd: &str) -> String {
    let normalized = clean_path(value);
    if normalized.is_empty() || windows_drive(&normalized) || normalized.starts_with('/') {
        return normalized;
    }
    let base = clean_path(cwd);
    if base.is_empty() {
        return normalized;
    }
    // POSIX normalization deliberately preserves Windows drive prefixes.
    let joined = format!("{base}/{normalized}");
    let absolute = joined.starts_with('/');
    let mut parts = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => (),
            ".." if parts.last().is_some_and(|last| *last != "..") => {
                parts.pop();
            }
            ".." if !absolute => parts.push(part),
            ".." => (),
            _ => parts.push(part),
        }
    }
    let prefix = if absolute { "/" } else { "" };
    let result = format!("{prefix}{}", parts.join("/"));
    if result.is_empty() {
        ".".to_owned()
    } else {
        result
    }
}

fn is_skill_path(value: &str) -> bool {
    clean_path(value)
        .rsplit('/')
        .next()
        .is_some_and(|s| s.eq_ignore_ascii_case("SKILL.md"))
}

fn get_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_owned();
    }
    content
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|part| {
                    matches!(
                        string(&part["type"]),
                        "input_text" | "output_text" | "Text" | "text"
                    )
                })
                .map(|part| string(&part["text"]))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn timestamp(value: &Value) -> Option<String> {
    let time = if let Some(number) = value.as_f64() {
        let millis = if number < 1e11 {
            number * 1000.0
        } else {
            number
        };
        if !millis.is_finite() || millis.abs() > 8.64e15 {
            return None;
        }
        DateTime::from_timestamp_millis(millis.trunc() as i64)?
    } else {
        let text = value.as_str()?.trim();
        if let Ok(time) = DateTime::parse_from_rfc3339(text) {
            time.with_timezone(&Utc)
        } else if let Ok(date) = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d") {
            date.and_hms_opt(0, 0, 0)?.and_utc()
        } else {
            return None;
        }
    };
    Some(time.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn latest(a: Option<String>, b: Option<String>) -> Option<String> {
    match (a, b) {
        (None, other) | (other, None) => other,
        (Some(a), Some(b)) => Some(if b > a { b } else { a }),
    }
}

fn json_object(value: &Value) -> Option<Value> {
    if value.is_object() || value.is_array() {
        return Some(value.clone());
    }
    let parsed: Value = serde_json::from_str(value.as_str()?).ok()?;
    (parsed.is_object() || parsed.is_array()).then_some(parsed)
}

#[derive(Clone)]
struct Definition {
    id: String,
    name: String,
    description: String,
    path: String,
}

fn extract_available_skills(text: &str) -> Vec<Definition> {
    let mut roots = HashMap::new();
    for captures in re(r"(?m)^\s*-\s*`([^`]+)`\s*=\s*`([^`]+)`\s*$").captures_iter(text) {
        roots.insert(captures[1].to_owned(), clean_path(&captures[2]));
    }
    let heading_re = re(r"(?im)^#{1,6}\s+Available skills\s*$");
    let Some(heading) = heading_re.find(text) else {
        return Vec::new();
    };
    let mut section = &text[heading.end()..];
    if let Some(next) = re(r"(?m)^#{1,6}\s+").find(section) {
        section = &section[..next.start()];
    }
    let mut definitions: Vec<Definition> = Vec::new();
    let mut indexes = HashMap::new();
    for captures in re(r"(?m)^\s*-\s+(.+?):\s+(.+?)\s+\(file:\s*(.+)\)\s*$").captures_iter(section)
    {
        let name = captures[1].trim().trim_matches(['*', '`']).to_owned();
        let mut file = clean_path(&captures[3]);
        if let Some((alias, suffix)) = file.split_once('/') {
            if let Some(root) = roots.get(alias) {
                file = format!("{root}/{suffix}");
            }
        }
        if !is_skill_path(&file) {
            continue;
        }
        let key = path_key(&file);
        let definition = Definition {
            id: file.clone(),
            name,
            description: captures[2].trim().to_owned(),
            path: file,
        };
        if let Some(&index) = indexes.get(&key) {
            definitions[index] = definition;
        } else {
            indexes.insert(key, definitions.len());
            definitions.push(definition);
        }
    }
    definitions
}

fn shell_skill_reads(command: &str, cwd: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut buffer = String::new();
    let mut quote = None;
    let mut skip_pipeline = false;
    let mut comment = false;
    let chars: Vec<char> = command.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if comment {
            if ch == '\n' {
                statements.push(std::mem::take(&mut buffer));
                comment = false;
                skip_pipeline = false;
            }
            i += 1;
            continue;
        }
        if let Some(q) = quote {
            if !skip_pipeline {
                buffer.push(ch);
            }
            if (ch == '`' || ch == '\\') && q == '"' && i + 1 < chars.len() {
                i += 1;
                if !skip_pipeline {
                    buffer.push(chars[i]);
                }
            } else if ch == q {
                if q == '\'' && chars.get(i + 1) == Some(&'\'') {
                    i += 1;
                    if !skip_pipeline {
                        buffer.push('\'');
                    }
                } else {
                    quote = None;
                }
            }
            i += 1;
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            if !skip_pipeline {
                buffer.push(ch);
            }
        } else if ch == '#' {
            comment = true;
        } else if ch == '\n' || ch == ';' || (ch == '&' && chars.get(i + 1) == Some(&'&')) {
            statements.push(std::mem::take(&mut buffer));
            skip_pipeline = false;
            if ch == '&' {
                i += 1;
            }
        } else if ch == '|' {
            skip_pipeline = true;
        } else if !skip_pipeline {
            buffer.push(ch);
        }
        i += 1;
    }
    statements.push(buffer);
    let statement_re = re(r"(?i)^\s*(?:Get-Content|cat|gc|type)\b\s+(.+)$");
    let tokens_re = re(r#"'(?:[^']|'')*'|"(?:[^"`]|`.)*"|[^\s|]+"#);
    let mut paths = Vec::new();
    for statement in statements {
        let Some(captures) = statement_re.captures(&statement) else {
            continue;
        };
        for matched in tokens_re.find_iter(&captures[1]) {
            let token = matched.as_str();
            if token == "|" {
                break;
            }
            if token.starts_with('-') {
                continue;
            }
            let token = token.strip_prefix(['\'', '"']).unwrap_or(token);
            let token = token
                .strip_suffix(['\'', '"'])
                .unwrap_or(token)
                .replace("''", "'");
            if token.chars().any(|c| matches!(c, '$' | '*' | '?' | '`')) {
                continue;
            }
            if is_skill_path(&token) {
                paths.push(resolve_path(&token, cwd));
            }
        }
    }
    paths
}

fn command_text(command: &Value) -> String {
    if let Some(text) = command.as_str() {
        return text.to_owned();
    }
    let Some(parts) = command.as_array() else {
        return String::new();
    };
    let start = parts
        .iter()
        .position(|part| {
            matches!(
                string(part).to_ascii_lowercase().as_str(),
                "-command" | "-c" | "/c"
            )
        })
        .map(|index| index + 1)
        .unwrap_or(0);
    parts[start..]
        .iter()
        .map(string)
        .collect::<Vec<_>>()
        .join(" ")
}

fn exit_code_is_zero(item: &Value) -> bool {
    let code = if item["exit_code"].is_null() {
        &item["exitCode"]
    } else {
        &item["exit_code"]
    };
    code.as_f64() == Some(0.0)
}

fn completed_read_paths(item: &Value, cwd: &str) -> Vec<String> {
    if !matches!(
        string(&item["type"]),
        "CommandExecution" | "command_execution"
    ) || item["status"] != "completed"
        || !exit_code_is_zero(item)
    {
        return Vec::new();
    }
    let mut paths = Vec::new();
    if let Some(commands) = item["parsed_cmd"].as_array() {
        for command in commands {
            if command["type"] == "read" && is_skill_path(string(&command["path"])) {
                paths.push(resolve_path(string(&command["path"]), cwd));
            }
        }
    }
    paths.extend(shell_skill_reads(&command_text(&item["command"]), cwd));
    let mut seen = HashSet::new();
    paths.retain(|path| seen.insert(path.clone()));
    paths
}

struct Skill {
    definition: Definition,
    available: bool,
    evidence: Vec<Value>,
    last_used_at: Option<String>,
    loaded_at: Option<String>,
    declared_at: Option<String>,
}

impl Skill {
    fn new(definition: Definition, available: bool) -> Self {
        Self {
            definition,
            available,
            evidence: Vec::new(),
            last_used_at: None,
            loaded_at: None,
            declared_at: None,
        }
    }
    fn status(&self) -> &str {
        if self.declared_at.is_some() {
            "declared"
        } else if self.loaded_at.is_some() {
            "loaded"
        } else {
            "available"
        }
    }
    fn to_json(&self, current_turn: &Option<String>) -> Value {
        let turn = json!(current_turn);
        json!({
            "id": self.definition.id, "path": self.definition.path,
            "name": self.definition.name, "description": self.definition.description,
            "available": self.available, "status": self.status(), "evidence": self.evidence,
            "lastUsedAt": self.last_used_at, "loadedAt": self.loaded_at, "declaredAt": self.declared_at,
            "currentTurnLoaded": self.evidence.iter().any(|entry| entry["kind"] == "loaded" && entry["turnId"] == turn),
            "currentTurnDeclared": self.evidence.iter().any(|entry| entry["kind"] == "declared" && entry["turnId"] == turn),
        })
    }
}

fn declaration_names(text: &str, skills: &[Skill]) -> Vec<String> {
    let unquoted = re(r"(?s)```.*?```").replace_all(text, "");
    let quoted_line = re(r"^\s*(?:>|\|)");
    let stripped = unquoted
        .lines()
        .filter(|line| !quoted_line.is_match(line))
        .collect::<Vec<_>>()
        .join("\n");
    let aliases: Vec<Vec<String>> = skills
        .iter()
        .map(|skill| {
            let name = &skill.definition.name;
            let short = name.rsplit(':').next().unwrap_or(name);
            let mut aliases = vec![name.clone()];
            if short != name
                && skills
                    .iter()
                    .filter(|s| s.definition.name.rsplit(':').next() == Some(short))
                    .count()
                    == 1
            {
                aliases.push(short.to_owned());
            }
            if short.contains('-') {
                aliases.push(short.replace('-', " "));
            }
            aliases
        })
        .collect();
    if aliases.is_empty() {
        return Vec::new();
    }
    let all_names = aliases
        .iter()
        .flatten()
        .map(|name| regex::escape(name))
        .collect::<Vec<_>>()
        .join("|");
    let prior = format!(r#"(?:[*`“"\[]*(?:{all_names})[*`”"\]]*(?:\s*,\s*|\s+(?:и|and|&)\s+))*"#);
    let negative_re = re(
        r"(?iu)(?:^|\s)(?:не|not|never|если|if|например|example|допустим|suppose|could|would|буду|могу)(?:\s|$)",
    );
    let mut result = Vec::new();
    for (skill, names) in skills.iter().zip(aliases.iter()) {
        let names = names
            .iter()
            .map(|name| regex::escape(name))
            .collect::<Vec<_>>()
            .join("|");
        // Rust regex does not implement lookahead; check the Unicode name
        // boundary explicitly after matching the declaration.
        let pattern = format!(
            r#"(?iu)(?:^|[\s.!?;:,])(?:я\s+)?(?:использую|применяю|I(?:\s+am|[’']m)?\s+(?:using|use)|Using)\s+(?:(?:этот\s+)?(?:скилл(?:ы|а)?|навык(?:и|а)?|skills?)\s*:?\s+)?{prior}[*`“"\[]*(?:{names})"#
        );
        for matched in re(&pattern).find_iter(&stripped) {
            if stripped[matched.end()..]
                .chars()
                .next()
                .is_some_and(|ch| ch.is_alphanumeric() || ch == '_' || ch == '-')
            {
                continue;
            }
            let prefix: String = stripped[..matched.start()]
                .chars()
                .rev()
                .take(90)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            let before = prefix.rsplit(['.', '!', '?', '\n']).next().unwrap_or("");
            let after: String = stripped[matched.start()..]
                .chars()
                .take(matched.as_str().chars().count() + 80)
                .collect();
            let after = after.split(['.', '!', '\n']).next().unwrap_or("");
            if negative_re.is_match(before) || after.contains('?') {
                continue;
            }
            result.push(skill.definition.id.clone());
            break;
        }
    }
    result
}

struct Pending {
    name: String,
    started_at: Option<String>,
    args: Option<Value>,
    turn_id: Option<String>,
}

struct State {
    cwd: String,
    skills: Vec<Skill>,
    indexes: HashMap<String, usize>,
    events: Vec<Value>,
    evidence_keys: HashSet<String>,
    seen_messages: HashSet<String>,
    available_at: Option<String>,
    available_source: Option<String>,
}

impl State {
    fn add_event(&mut self, event: Value) {
        self.events.push(event);
        if self.events.len() > MAX_EVENTS {
            self.events.remove(0);
        }
    }
    fn apply_catalog(&mut self, text: &str, at: &Option<String>, source: &str) {
        for skill in &mut self.skills {
            skill.available = false;
        }
        for definition in extract_available_skills(text) {
            let key = path_key(&definition.path);
            if let Some(&index) = self.indexes.get(&key) {
                self.skills[index].definition = definition;
                self.skills[index].available = true;
            } else {
                self.indexes.insert(key, self.skills.len());
                self.skills.push(Skill::new(definition, true));
            }
        }
        self.available_at = at.clone();
        self.available_source = Some(source.to_owned());
    }
    fn observe(
        &mut self,
        file: &str,
        kind: &str,
        at: &Option<String>,
        turn_id: &Option<String>,
        source: &str,
    ) {
        let normalized = resolve_path(file, &self.cwd);
        let key = path_key(&normalized);
        if key.is_empty() {
            return;
        }
        let index = if let Some(&index) = self.indexes.get(&key) {
            index
        } else {
            let name = normalized
                .rsplit('/')
                .nth(1)
                .filter(|s| !s.is_empty())
                .unwrap_or("skill")
                .to_owned();
            let index = self.skills.len();
            self.indexes.insert(key.clone(), index);
            self.skills.push(Skill::new(
                Definition {
                    id: normalized.clone(),
                    path: normalized,
                    name,
                    description: String::new(),
                },
                false,
            ));
            index
        };
        let evidence_key = format!(
            "{key}|{kind}|{}",
            turn_id
                .as_ref()
                .or(at.as_ref())
                .map(String::as_str)
                .unwrap_or("null")
        );
        if !self.evidence_keys.insert(evidence_key) {
            return;
        }
        let label = if kind == "loaded" {
            "Файл SKILL.md прочитан"
        } else {
            "Агент сообщил о применении"
        };
        let skill = &mut self.skills[index];
        skill.evidence.push(
            json!({ "kind": kind, "label": label, "at": at, "turnId": turn_id, "source": source }),
        );
        if skill.evidence.len() > MAX_EVIDENCE {
            skill.evidence.remove(0);
        }
        if kind == "loaded" {
            skill.loaded_at = latest(skill.loaded_at.take(), at.clone());
        }
        if kind == "declared" {
            skill.declared_at = latest(skill.declared_at.take(), at.clone());
        }
        skill.last_used_at = latest(skill.last_used_at.take(), at.clone());
        let event = json!({ "kind": kind, "label": format!("{}: {}", skill.definition.name, label.to_lowercase()), "at": at, "skillId": skill.definition.id, "turnId": turn_id });
        self.add_event(event);
    }
    fn assistant_message(
        &mut self,
        content: &Value,
        at: &Option<String>,
        turn_id: &Option<String>,
        id: &Value,
    ) {
        let text = get_text(content);
        let key = optional_string(id).unwrap_or_else(|| text.clone());
        if text.is_empty() || !self.seen_messages.insert(key) {
            return;
        }
        for id in declaration_names(&text, &self.skills) {
            self.observe(&id, "declared", at, turn_id, "assistant-message");
        }
    }
}

/// Return only session observations and labels, never raw rollout contents.
pub fn parse_session_records(records: &[Value], metadata: &Value) -> Value {
    let now = timestamp(&metadata["now"])
        .unwrap_or_else(|| Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
    let mut id = optional_string(&metadata["id"]);
    let mut title = string(&metadata["title"]).to_owned();
    let mut model = optional_string(&metadata["model"]);
    let mut parent_id = first_string(&[&metadata["parentId"], &metadata["parent_id"]]);
    let mut status = "unknown";
    let mut status_source = "no-lifecycle-event";
    let mut current_turn_id = None;
    let updated = if metadata["updated_at_ms"].is_null() {
        &metadata["updated_at"]
    } else {
        &metadata["updated_at_ms"]
    };
    let mut updated_at = timestamp(updated);
    let mut last_event_at = None;
    let mut state = State {
        cwd: string(&metadata["cwd"]).to_owned(),
        skills: Vec::new(),
        indexes: HashMap::new(),
        events: Vec::new(),
        evidence_keys: HashSet::new(),
        seen_messages: HashSet::new(),
        available_at: None,
        available_source: None,
    };
    let mut pending: Vec<(String, Pending)> = Vec::new();
    let mut emitted = HashSet::new();
    for (record_index, record) in records.iter().enumerate() {
        let p = &record["payload"];
        if !p.is_object() && !p.is_array() {
            continue;
        }
        let at = timestamp(&record["timestamp"]).or_else(|| last_event_at.clone());
        last_event_at = latest(last_event_at, at.clone());
        updated_at = latest(updated_at, at.clone());
        let turn_id = optional_string(&p["turn_id"]).or_else(|| current_turn_id.clone());
        match string(&record["type"]) {
            "session_meta" => {
                id = id.or_else(|| first_string(&[&p["id"], &p["session_id"]]));
                if state.cwd.is_empty() {
                    state.cwd = string(&p["cwd"]).to_owned();
                }
                parent_id = parent_id.or_else(|| {
                    first_string(&[
                        &p["parent_thread_id"],
                        &p["parent_id"],
                        &p["source"]["subagent"]["thread_spawn"]["parent_thread_id"],
                    ])
                });
            }
            "turn_context" => {
                model = optional_string(&p["model"]).or(model);
                if let Some(cwd) = optional_string(&p["cwd"]) {
                    state.cwd = cwd;
                }
                current_turn_id = optional_string(&p["turn_id"]).or(current_turn_id);
            }
            "world_state" => {
                if let Some(body) = p["state"]["host_skills"]["body"].as_str() {
                    state.apply_catalog(body, &at, "world-state");
                } else if p["full"] == true {
                    state.apply_catalog("", &at, "world-state");
                }
                if let Some(value) = p["state"]["model"].as_str() {
                    model = Some(value.to_owned());
                } else if let Some(value) = p["state"]["model"]["slug"].as_str() {
                    model = Some(value.to_owned());
                }
            }
            "event_msg" => {
                let event_type = string(&p["type"]);
                if matches!(
                    event_type,
                    "task_started" | "task_complete" | "task_completed" | "turn_aborted"
                ) {
                    status = if event_type == "task_started" {
                        "active"
                    } else if event_type == "turn_aborted" {
                        "interrupted"
                    } else {
                        "idle"
                    };
                    status_source = match event_type {
                        "task_started" => "task_started",
                        "turn_aborted" => "turn_aborted",
                        "task_completed" => "task_completed",
                        _ => "task_complete",
                    };
                    current_turn_id = optional_string(&p["turn_id"]).or(current_turn_id);
                    pending.clear();
                    let label = if event_type == "task_started" {
                        "Ход начат"
                    } else if event_type == "turn_aborted" {
                        "Ход прерван"
                    } else {
                        "Ход завершён"
                    };
                    state.add_event(json!({ "kind": status, "label": label, "at": at, "turnId": current_turn_id }));
                }
                let item = &p["item"];
                let item_type = string(&item["type"]);
                if item.is_object()
                    && event_type == "item_started"
                    && [
                        "ToolCall",
                        "CommandExecution",
                        "tool_call",
                        "command_execution",
                    ]
                    .iter()
                    .any(|suffix| item_type.ends_with(suffix))
                {
                    let key = format!(
                        "item:{}",
                        optional_string(&item["id"]).unwrap_or_else(|| "undefined".to_owned())
                    );
                    let name = first_string(&[&item["tool"], &item["name"]]).unwrap_or_else(|| {
                        if item_type == "CommandExecution" {
                            "exec_command".to_owned()
                        } else {
                            item_type.to_owned()
                        }
                    });
                    upsert_pending(
                        &mut pending,
                        key,
                        Pending {
                            name,
                            started_at: at.clone(),
                            args: None,
                            turn_id: None,
                        },
                    );
                }
                if item.is_object() && event_type == "item_completed" {
                    let key = format!(
                        "item:{}",
                        optional_string(&item["id"]).unwrap_or_else(|| "undefined".to_owned())
                    );
                    pending.retain(|(id, _)| id != &key);
                    let identity = optional_string(&item["id"])
                        .unwrap_or_else(|| format!("unidentified-item-{record_index}"));
                    if emitted.insert(identity) {
                        for file in completed_read_paths(item, &state.cwd) {
                            state.observe(&file, "loaded", &at, &turn_id, "command-execution");
                        }
                        if item_type == "AgentMessage" && item["phase"] != "analysis" {
                            state.assistant_message(&item["content"], &at, &turn_id, &item["id"]);
                        }
                    }
                }
            }
            "response_item" => {
                let item_type = string(&p["type"]);
                if item_type == "message" && p["role"] == "developer" {
                    let text = get_text(&p["content"]);
                    if re(r"(?im)^#{1,6}\s+Available skills\s*$").is_match(&text) {
                        state.apply_catalog(&text, &at, "developer-message");
                    }
                } else if item_type == "message"
                    && p["role"] == "assistant"
                    && p["channel"] != "analysis"
                {
                    state.assistant_message(&p["content"], &at, &turn_id, &p["id"]);
                } else if matches!(item_type, "function_call" | "custom_tool_call") {
                    let key = first_string(&[&p["call_id"], &p["id"]]).unwrap_or_default();
                    let name = [string(&p["namespace"]), string(&p["name"])]
                        .into_iter()
                        .filter(|part| !part.is_empty())
                        .collect::<Vec<_>>()
                        .join(".");
                    upsert_pending(
                        &mut pending,
                        key,
                        Pending {
                            name: if name.is_empty() {
                                "tool".to_owned()
                            } else {
                                name
                            },
                            started_at: at.clone(),
                            args: json_object(&p["arguments"]),
                            turn_id: turn_id.clone(),
                        },
                    );
                } else if matches!(
                    item_type,
                    "function_call_output" | "custom_tool_call_output"
                ) {
                    let key = first_string(&[&p["call_id"], &p["id"]]).unwrap_or_default();
                    if let Some(index) = pending.iter().position(|(id, _)| id == &key) {
                        let (_, call) = pending.remove(index);
                        if let Some(result) = json_object(&p["output"]) {
                            if result["isError"] != true && exit_code_is_zero(&result) {
                                if let Some(args) = call.args {
                                    let command = if truthy(&args["cmd"]) {
                                        &args["cmd"]
                                    } else {
                                        &args["command"]
                                    };
                                    for file in
                                        shell_skill_reads(&command_text(command), &state.cwd)
                                    {
                                        state.observe(
                                            &file,
                                            "loaded",
                                            &at,
                                            &call.turn_id,
                                            "function-call-output",
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
            _ => (),
        }
    }
    if title.is_empty() {
        title = id
            .as_ref()
            .map(|id| format!("Сессия {}", id.chars().take(8).collect::<String>()))
            .unwrap_or_else(|| "Сессия".to_owned());
    }
    if status == "active"
        && last_event_at.as_ref().is_none_or(|at| {
            let elapsed = DateTime::parse_from_rfc3339(&now)
                .ok()
                .zip(DateTime::parse_from_rfc3339(at).ok())
                .map(|(now, at)| now.timestamp_millis() - at.timestamp_millis())
                .unwrap_or(0);
            elapsed > STALE_MS
        })
    {
        status = "unknown";
        status_source = "stale-active-event";
    }
    let current_tool = if status == "active" {
        // Keep insertion order for tools with equal timestamps, like stable JS sort.
        pending
            .iter()
            .enumerate()
            .max_by(|(a_index, (_, a)), (b_index, (_, b))| {
                a.started_at
                    .cmp(&b.started_at)
                    .then_with(|| b_index.cmp(a_index))
            })
            .map(|(_, (_, tool))| json!({ "name": tool.name, "startedAt": tool.started_at }))
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let mut visible: Vec<&Skill> = state
        .skills
        .iter()
        .filter(|skill| skill.available || !skill.evidence.is_empty())
        .collect();
    let rank = |skill: &&Skill| match skill.status() {
        "declared" => 0,
        "loaded" => 1,
        _ => 2,
    };
    visible.sort_by(|a, b| {
        rank(a).cmp(&rank(b)).then_with(|| {
            a.definition
                .name
                .to_lowercase()
                .cmp(&b.definition.name.to_lowercase())
        })
    });
    let skills: Vec<Value> = visible
        .into_iter()
        .map(|skill| skill.to_json(&current_turn_id))
        .collect();
    let archived = truthy(&metadata["archived"]);
    json!({
        "id": id, "title": title, "cwd": state.cwd, "model": model, "parentId": parent_id,
        "status": status, "statusSource": status_source, "currentTurnId": current_turn_id,
        "updatedAt": updated_at, "lastEventAt": last_event_at, "currentTool": current_tool,
        "skills": skills, "events": state.events, "availableSnapshotAt": state.available_at,
        "availableSource": state.available_source, "availableScope": "session", "source": "local-rollout", "archived": archived,
    })
}

fn upsert_pending(pending: &mut Vec<(String, Pending)>, key: String, call: Pending) {
    if let Some((_, value)) = pending.iter_mut().find(|(id, _)| id == &key) {
        *value = call;
    } else {
        pending.push((key, call));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATH: &str = "C:/Users/test/.codex/skills/openai-docs/SKILL.md";
    const CATALOG: &str = "## Skills\n### Skill roots\n- `r0` = `C:/Users/test/.codex/skills`\n- `r1` = `C:/Some Folder/plugins`\n### Available skills\n- openai-docs: Official documentation. (file: r0/openai-docs/SKILL.md)\n- pdf:pdf: Read PDFs. (file: r1/pdf/skills/pdf/SKILL.md)\n";

    fn row(kind: &str, payload: Value) -> Value {
        json!({ "type": kind, "payload": payload, "timestamp": "2026-10-18T13:00:00Z" })
    }
    fn world() -> Value {
        row(
            "world_state",
            json!({ "full": true, "state": { "host_skills": { "body": CATALOG } } }),
        )
    }
    fn start(turn: &str) -> Value {
        row(
            "event_msg",
            json!({ "type": "task_started", "turn_id": turn }),
        )
    }
    fn message(text: &str) -> Value {
        row(
            "response_item",
            json!({ "type": "message", "role": "assistant", "channel": "commentary", "content": [{ "type": "output_text", "text": text }] }),
        )
    }
    fn read(overrides: Value) -> Value {
        let mut item = json!({ "id": "cmd", "type": "CommandExecution", "status": "completed", "exit_code": 0, "command": ["pwsh.exe", "-Command", format!("Get-Content -LiteralPath '{PATH}'")], "parsed_cmd": [{ "type": "read", "path": PATH }] });
        if let Some(overrides) = overrides.as_object() {
            for (key, value) in overrides {
                item[key] = value.clone();
            }
        }
        row(
            "event_msg",
            json!({ "type": "item_completed", "item": item }),
        )
    }
    fn parse(records: Vec<Value>) -> Value {
        parse_session_records(
            &records,
            &json!({ "id": "thread-1", "title": "Widget", "now": "2026-10-18T13:05:00Z" }),
        )
    }
    fn skill(session: &Value) -> &Value {
        session["skills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == "openai-docs")
            .unwrap()
    }

    #[test]
    fn matches_frozen_electron_parser_observations() {
        // Synthetic fixtures were captured from the released JavaScript parser
        // before replacing it. No Node runtime is required to run this test.
        let fixtures: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/parser-migration.json"))
                .unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let actual =
                parse_session_records(fixture["records"].as_array().unwrap(), &fixture["metadata"]);
            assert_eq!(
                actual, fixture["expected"],
                "compatibility case {}",
                fixture["name"]
            );
        }
    }

    #[test]
    fn catalog_expands_aliases_and_scopes_snapshot() {
        let definitions = extract_available_skills(CATALOG);
        assert_eq!(definitions.len(), 2);
        assert_eq!(definitions[0].id, PATH);
        assert_eq!(definitions[1].name, "pdf:pdf");
        assert_eq!(
            definitions[1].path,
            "C:/Some Folder/plugins/pdf/skills/pdf/SKILL.md"
        );
        assert!(extract_available_skills("mention (file: r0/foo/SKILL.md)").is_empty());
        let session = parse(vec![
            world(),
            row(
                "world_state",
                json!({ "full": false, "state": { "environments": [] } }),
            ),
        ]);
        assert_eq!(session["skills"].as_array().unwrap().len(), 2);
        assert_eq!(session["availableSource"], "world-state");
        let replacement = parse(vec![
            start("t"),
            world(),
            read(json!({})),
            row("world_state", json!({ "full": true, "state": {} })),
        ]);
        assert_eq!(replacement["skills"].as_array().unwrap().len(), 1);
        assert_eq!(skill(&replacement)["available"], false);
        assert_eq!(skill(&replacement)["status"], "loaded");
    }

    #[test]
    fn only_completed_successful_real_reads_count() {
        let session = parse(vec![
            start("turn-1"),
            world(),
            read(json!({ "aggregated_output": "PRIVATE INSTRUCTIONS" })),
        ]);
        assert_eq!(skill(&session)["currentTurnLoaded"], true);
        assert_eq!(skill(&session)["evidence"][0]["turnId"], "turn-1");
        assert!(!session.to_string().contains("PRIVATE"));
        for override_ in [
            json!({ "exit_code": 1 }),
            json!({ "status": "failed" }),
            json!({ "status": "in_progress" }),
            json!({ "exit_code": null }),
        ] {
            assert_eq!(
                skill(&parse(vec![world(), read(override_)]))["status"],
                "available"
            );
        }
        for command in [
            format!("rg 'SKILL.md' '{PATH}'"),
            format!("Write-Output 'Get-Content {PATH}'"),
            format!("Write-Output 'example; Get-Content {PATH}'"),
            format!("echo Get-Content {PATH}"),
            format!("Get-Content C:/ordinary.txt | rg '{PATH}'"),
            format!("Get-Content C:/ordinary.txt # {PATH}"),
            "cat $HOME/skills/openai-docs/SKILL.md".to_owned(),
            "cat C:/skills/*/SKILL.md".to_owned(),
        ] {
            assert_eq!(
                skill(&parse(vec![
                    world(),
                    read(
                        json!({ "command": command, "parsed_cmd": [], "aggregated_output": PATH })
                    )
                ]))["status"],
                "available",
                "{command}"
            );
        }
        let session = parse(vec![
            world(),
            read(
                json!({ "parsed_cmd": [], "command": ["pwsh", "-Command", "Get-Location\nGet-Content -Raw 'c:\\users\\test\\.codex\\skills\\openai-docs\\SKILL.md'\nGet-Date"] }),
            ),
        ]);
        assert_eq!(skill(&session)["status"], "loaded");
        assert_eq!(session["skills"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn declarations_are_explicit_and_lists_do_not_capture_later_mentions() {
        for text in [
            "Использую скилл `openai-docs` для проверки.",
            "Использую навык OpenAI Docs для проверки.",
            "I am using openai-docs for verification.",
        ] {
            let session = parse(vec![start("t"), world(), message(text)]);
            assert_eq!(skill(&session)["status"], "declared", "{text}");
            assert_eq!(
                skill(&session)["evidence"][0]["label"],
                "Агент сообщил о применении"
            );
        }
        let list = parse(vec![
            start("t"),
            world(),
            message("Использую навыки: `pdf` и `openai-docs` для проверки."),
        ]);
        assert!(list["skills"]
            .as_array()
            .unwrap()
            .iter()
            .all(|skill| skill["currentTurnDeclared"] == true));
        assert_eq!(
            skill(&parse(vec![
                world(),
                message("Использую pdf для проверки того, доступен ли openai-docs.")
            ]))["status"],
            "available"
        );
        for text in [
            "Не использую openai-docs.",
            "Я не всегда использую openai-docs.",
            "Если необходимо, использую openai-docs.",
            "Например использую openai-docs.",
            "Можно использовать openai-docs.",
            "Использую openai-docs?",
            "> Использую openai-docs.",
            "```\nИспользую openai-docs\n```",
            "Использую openai-docs-extra.",
            "Использую openai-docsЖ.",
        ] {
            assert_eq!(
                skill(&parse(vec![world(), message(text)]))["status"],
                "available",
                "{text}"
            );
        }
        let analysis = row(
            "response_item",
            json!({ "type": "message", "role": "assistant", "channel": "analysis", "content": "Использую openai-docs" }),
        );
        assert_eq!(
            skill(&parse(vec![world(), analysis]))["status"],
            "available"
        );
    }

    #[test]
    fn observations_are_deduplicated_and_historical_use_is_not_current() {
        let call = row(
            "response_item",
            json!({ "type": "function_call", "call_id": "c", "name": "exec_command", "arguments": json!({ "cmd": format!("Get-Content '{PATH}'") }).to_string() }),
        );
        let output = row(
            "response_item",
            json!({ "type": "function_call_output", "call_id": "c", "output": "{\"exit_code\":0,\"output\":\"PRIVATE OUTPUT\"}" }),
        );
        let session = parse(vec![
            start("t"),
            world(),
            call,
            read(json!({})),
            output,
            message("Использую openai-docs."),
            message("Использую openai-docs."),
        ]);
        assert_eq!(skill(&session)["evidence"].as_array().unwrap().len(), 2);
        assert!(!session.to_string().contains("PRIVATE"));
        assert!(session["currentTool"].is_null());
        let history = parse(vec![
            start("turn-1"),
            world(),
            read(json!({})),
            message("Использую openai-docs."),
            row(
                "event_msg",
                json!({ "type": "task_complete", "turn_id": "turn-1" }),
            ),
            start("turn-2"),
        ]);
        assert_eq!(skill(&history)["status"], "declared");
        assert_eq!(skill(&history)["currentTurnLoaded"], false);
        assert_eq!(skill(&history)["currentTurnDeclared"], false);
        assert_eq!(history["status"], "active");
    }

    #[test]
    fn pending_tools_lifecycle_and_staleness() {
        let mut call = row(
            "response_item",
            json!({ "type": "function_call", "call_id": "c", "name": "exec", "namespace": "functions", "arguments": "{}" }),
        );
        call["timestamp"] = json!("2026-10-18T13:04:00Z");
        let records = vec![start("t"), call];
        assert_eq!(
            parse(records.clone())["currentTool"],
            json!({ "name": "functions.exec", "startedAt": "2026-10-18T13:04:00.000Z" })
        );
        let stale = parse_session_records(&records, &json!({ "now": "2026-10-18T13:20:00Z" }));
        assert_eq!(stale["status"], "unknown");
        assert_eq!(stale["statusSource"], "stale-active-event");
        assert!(stale["currentTool"].is_null());
        for (kind, expected) in [("task_complete", "idle"), ("turn_aborted", "interrupted")] {
            let mut finished = records.clone();
            finished.push(row("event_msg", json!({ "type": kind, "turn_id": "t" })));
            let session = parse(finished);
            assert_eq!(session["status"], expected);
            assert!(session["currentTool"].is_null());
        }
    }

    #[test]
    fn developer_catalogs_metadata_relative_paths_and_malformed_records() {
        let session = parse(vec![
            Value::Null,
            json!(42),
            json!({}),
            json!({ "type": "event_msg" }),
            row(
                "response_item",
                json!({ "type": "message", "role": "developer", "content": [{ "type": "input_text", "text": CATALOG }] }),
            ),
        ]);
        assert_eq!(session["skills"].as_array().unwrap().len(), 2);
        assert_eq!(session["availableSource"], "developer-message");
        assert_eq!(session["status"], "unknown");
        let session = parse_session_records(
            &[
                row(
                    "session_meta",
                    json!({ "id": "abcdefghijk", "cwd": "/work/project", "source": { "subagent": { "thread_spawn": { "parent_thread_id": "parent" } } } }),
                ),
                read(json!({ "command": "cat ../skills/unicode/SKILL.md", "parsed_cmd": [] })),
            ],
            &json!({ "updated_at": 1792328400, "archived": 1, "now": "2026-10-18T13:05:00Z" }),
        );
        assert_eq!(session["parentId"], "parent");
        assert_eq!(session["title"], "Сессия abcdefgh");
        assert_eq!(
            session["skills"][0]["path"],
            "/work/skills/unicode/SKILL.md"
        );
        assert_eq!(session["archived"], true);
        assert_eq!(
            clean_path("file:///C:/Some%20Folder/SKILL.md"),
            "C:/Some Folder/SKILL.md"
        );
        assert_eq!(
            clean_path("file:///home/test/SKILL.md"),
            "/home/test/SKILL.md"
        );
    }

    #[test]
    fn evidence_and_activity_are_bounded_and_unicode_aliases_are_safe() {
        let unicode_catalog = "### Available skills\n- plugin:проверка: Русский навык. (file: /skills/проверка/SKILL.md)\n- other:проверка: Другой навык. (file: /skills/другой/SKILL.md)\n";
        let world = row(
            "world_state",
            json!({ "state": { "host_skills": { "body": unicode_catalog } } }),
        );
        let ambiguous = parse(vec![world.clone(), message("Использую проверка.")]);
        assert!(ambiguous["skills"]
            .as_array()
            .unwrap()
            .iter()
            .all(|skill| skill["status"] == "available"));
        let named = parse(vec![world, message("Использую plugin:проверка.")]);
        assert_eq!(named["skills"][0]["status"], "declared");
        let mut records = vec![super::tests::world()];
        for i in 0..100 {
            records.push(start(&format!("turn-{i}")));
            records.push(read(json!({ "id": format!("read-{i}") })));
        }
        let session = parse(records);
        assert_eq!(session["events"].as_array().unwrap().len(), MAX_EVENTS);
        assert_eq!(
            skill(&session)["evidence"].as_array().unwrap().len(),
            MAX_EVIDENCE
        );
    }
}
