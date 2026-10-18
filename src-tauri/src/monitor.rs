//! Read-only access to the local Codex thread database and rollout journals.
//!
//! A journal is opened only after both its lexical and canonical paths have
//! been checked against the known journal directories. SQLite is opened in
//! read-only mode; this module never modifies Codex data.

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{types::ValueRef, Connection, OpenFlags};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, Metadata};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

const STALE_MS: i64 = 10 * 60 * 1_000;
const REQUIRED_COLUMNS: &[&str] = &["id", "rollout_path", "title", "cwd", "updated_at"];
const OPTIONAL_COLUMNS: &[&str] = &[
    "source",
    "name",
    "model",
    "agent_nickname",
    "agent_path",
    "updated_at_ms",
    "archived",
];

#[derive(Clone, PartialEq, Eq)]
struct FileStamp {
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

impl FileStamp {
    fn from_metadata(metadata: &Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        }
    }

    fn same_identity(&self, other: &Self) -> bool {
        if self.created != other.created {
            return false;
        }
        #[cfg(unix)]
        if self.device != other.device || self.inode != other.inode {
            return false;
        }
        true
    }
}

#[derive(Default)]
struct JournalCache {
    offset: u64,
    remainder: Vec<u8>,
    records: Vec<Value>,
    malformed: usize,
    parsed: Option<Value>,
    metadata: Option<Value>,
    prefix: Vec<u8>,
    tail: Vec<u8>,
    stamp: Option<FileStamp>,
}

pub struct Monitor {
    home: PathBuf,
    roots: Vec<PathBuf>,
    limit: usize,
    cache: HashMap<PathBuf, JournalCache>,
    last_state: Option<Value>,
    // Also lets the incremental reader's tests assert actual I/O rather than
    // inferring it from the returned data.
    journal_bytes_read: u64,
}

impl Monitor {
    pub fn new(codex_home: Option<PathBuf>, limit: usize) -> Self {
        let home = codex_home
            .or_else(|| nonempty_env("SKILL_DESK_CODEX_HOME").map(PathBuf::from))
            .or_else(|| nonempty_env("CODEX_HOME").map(PathBuf::from))
            .unwrap_or_else(|| default_home().join(".codex"));
        let home = absolute_normalized(&home);
        Self {
            roots: ["sessions", "archived_sessions", "archive"]
                .iter()
                .map(|name| home.join(name))
                .collect(),
            home,
            limit: limit.clamp(1, 200),
            cache: HashMap::new(),
            last_state: None,
            journal_bytes_read: 0,
        }
    }

    pub fn get_state(&mut self) -> Value {
        self.get_state_at(Utc::now().timestamp_millis())
    }

    pub fn close(&mut self) {
        self.cache.clear();
        self.last_state = None;
    }

    fn get_state_at(&mut self, now: i64) -> Value {
        let mut warnings = Vec::<String>::new();
        let mut info = Vec::<String>::new();
        let mut sessions = Vec::<Value>::new();
        let mut health = "ok";
        let (mut missing, mut unreadable, mut rejected, mut malformed) = (0, 0, 0, 0);

        match self.read_thread_rows() {
            Ok(rows) => {
                let previous: HashMap<String, Value> = self
                    .last_state
                    .as_ref()
                    .and_then(|state| state["sessions"].as_array())
                    .into_iter()
                    .flatten()
                    .filter_map(|session| {
                        session["id"]
                            .as_str()
                            .map(|id| (id.to_owned(), session.clone()))
                    })
                    .collect();
                let mut used_files = HashSet::new();
                for row in rows {
                    let result = self.read_session(&row, now, &mut used_files);
                    match result {
                        Ok(Some((session, bad_records))) => {
                            malformed += bad_records;
                            sessions.push(session);
                        }
                        Ok(None) => rejected += 1,
                        Err(error) => {
                            if missing_path(&error) {
                                missing += 1;
                            } else {
                                unreadable += 1;
                            }
                            if let Some(old) = row["id"].as_str().and_then(|id| previous.get(id)) {
                                sessions.push(unavailable(old, "journal-unavailable"));
                            }
                        }
                    }
                }
                self.cache.retain(|path, _| used_files.contains(path));
                if missing > 0 {
                    info.push(format!("У {missing} сессий нет локального журнала: они могли быть удалены или созданы на другом устройстве."));
                }
                if rejected > 0 {
                    info.push(format!(
                        "Пропущено журналов вне папки сессий Codex: {rejected}."
                    ));
                }
                if malformed > 0 {
                    info.push(format!(
                        "Пропущено повреждённых записей журналов: {malformed}."
                    ));
                }
                if unreadable > 0 {
                    health = "partial";
                    warnings.push(format!(
                        "Не удалось прочитать журналов: {unreadable}. Показаны доступные данные."
                    ));
                }
            }
            Err(message) => {
                health = "error";
                warnings.push(message);
                sessions = self
                    .last_state
                    .as_ref()
                    .and_then(|state| state["sessions"].as_array())
                    .into_iter()
                    .flatten()
                    .map(|session| unavailable(session, "data-source-unavailable"))
                    .collect();
            }
        }

        let state = json!({
            "generatedAt": iso_time(now),
            "refreshMs": 3000,
            "currentSessionId": nonempty_env("CODEX_THREAD_ID").or_else(|| nonempty_env("CODEX_SESSION_ID")),
            "source": {
                "mode": "local-logs", "label": "Локальные журналы Codex", "health": health,
                "detail": "Чтение локальной базы и журналов. Статусы отражают последние записанные события; удалённые чаты без локального журнала не видны.",
                "info": info, "missingJournals": missing, "unreadableJournals": unreadable,
                "rejectedJournals": rejected, "malformedRecords": malformed,
            },
            "warnings": warnings,
            "sessions": sessions,
        });
        self.last_state = Some(state.clone());
        state
    }

    fn read_session(
        &mut self,
        row: &Value,
        now: i64,
        used_files: &mut HashSet<PathBuf>,
    ) -> io::Result<Option<(Value, usize)>> {
        let Some(file) = self.allowed_file(row["rollout_path"].as_str())? else {
            return Ok(None);
        };
        used_files.insert(file.clone());
        let entry = self.read_records(&file)?;
        let mut metadata = row.clone();
        if row["name"].as_str().is_some_and(|name| !name.is_empty()) {
            metadata["title"] = row["name"].clone();
        }
        if entry.parsed.is_none() || entry.metadata.as_ref() != Some(&metadata) {
            entry.metadata = Some(metadata.clone());
            metadata["now"] = json!(now);
            entry.parsed = Some(crate::parser::parse_session_records(
                &entry.records,
                &metadata,
            ));
        }
        let mut session = entry.parsed.as_ref().expect("parsed session").clone();
        let last_event = session["lastEventAt"]
            .as_str()
            .or_else(|| session["updatedAt"].as_str())
            .and_then(parse_time);
        if session["status"] == "active" && last_event.is_some_and(|at| now - at > STALE_MS) {
            session["status"] = json!("unknown");
            session["statusSource"] = json!("stale-active-event");
            session["currentTool"] = Value::Null;
        }
        Ok(Some((session, entry.malformed)))
    }

    fn find_state_db(&self) -> Result<PathBuf, String> {
        let entries = fs::read_dir(&self.home)
            .map_err(|_| "Не удалось открыть папку данных Codex.".to_owned())?;
        let mut found: Option<(u64, PathBuf)> = None;
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(version) = name
                .strip_prefix("state_")
                .and_then(|name| name.strip_suffix(".sqlite"))
                .filter(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
                .and_then(|digits| digits.parse::<u64>().ok())
            else {
                continue;
            };
            if found.as_ref().is_none_or(|(number, _)| version > *number) {
                found = Some((version, entry.path()));
            }
        }
        found
            .map(|(_, file)| file)
            .ok_or_else(|| "База сессий Codex не найдена. Откройте локальный чат Codex.".to_owned())
    }

    fn read_thread_rows(&self) -> Result<Vec<Value>, String> {
        let file = self.find_state_db()?;
        let data_error = || {
            "Не удалось прочитать локальную базу сессий Codex. Данные временно недоступны."
                .to_owned()
        };
        let db = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| data_error())?;
        db.busy_timeout(Duration::from_millis(1_000))
            .map_err(|_| data_error())?;
        db.pragma_update(None, "query_only", true)
            .map_err(|_| data_error())?;
        let columns: HashSet<String> = db
            .prepare("PRAGMA table_info(threads)")
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| row.get::<_, String>(1))?
                    .collect()
            })
            .map_err(|_| data_error())?;
        let absent: Vec<&str> = REQUIRED_COLUMNS
            .iter()
            .copied()
            .filter(|column| !columns.contains(*column))
            .collect();
        if !absent.is_empty() {
            return Err(format!(
                "Формат базы Codex изменился: отсутствуют поля {}.",
                absent.join(", ")
            ));
        }
        let mut selected = REQUIRED_COLUMNS.to_vec();
        selected.extend(
            OPTIONAL_COLUMNS
                .iter()
                .copied()
                .filter(|column| columns.contains(*column)),
        );
        let sql = format!(
            "SELECT {} FROM threads {} ORDER BY updated_at DESC LIMIT ?1",
            selected.join(","),
            if columns.contains("archived") {
                "WHERE archived=0"
            } else {
                ""
            }
        );
        let mut statement = db.prepare(&sql).map_err(|_| data_error())?;
        let rows = statement
            .query_map([self.limit as i64], |row| {
                let mut object = Map::new();
                for (index, name) in selected.iter().enumerate() {
                    let value = match row.get_ref(index)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(number) => json!(number),
                        ValueRef::Real(number) => json!(number),
                        ValueRef::Text(text) => json!(String::from_utf8_lossy(text)),
                        // None of the supported thread metadata fields is binary.
                        ValueRef::Blob(_) => Value::Null,
                    };
                    object.insert((*name).to_owned(), value);
                }
                Ok(Value::Object(object))
            })
            .map_err(|_| data_error())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| data_error())
    }

    fn allowed_file(&self, raw: Option<&str>) -> io::Result<Option<PathBuf>> {
        let Some(raw) = raw.filter(|raw| !raw.is_empty()) else {
            return Ok(None);
        };
        let file = if raw.starts_with("file:") {
            let Ok(url) = url::Url::parse(raw) else {
                return Ok(None);
            };
            let Ok(file) = url.to_file_path() else {
                return Ok(None);
            };
            file
        } else {
            PathBuf::from(raw)
        };
        let file = absolute_normalized(&file);
        if !file
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl"))
        {
            return Ok(None);
        }
        let Some(root) = self.roots.iter().find(|root| inside(root, &file)) else {
            return Ok(None);
        };
        // Keep the lexical check above canonicalization: a database row must
        // never make us inspect a path outside the known journals.
        let real_root = fs::canonicalize(root)?;
        let real_file = fs::canonicalize(file)?;
        Ok(inside(&real_root, &real_file).then_some(real_file))
    }

    fn read_records(&mut self, file: &Path) -> io::Result<&mut JournalCache> {
        let mut handle = File::open(file)?;
        let metadata = handle.metadata()?;
        if !metadata.is_file() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "not-a-file"));
        }
        let stamp = FileStamp::from_metadata(&metadata);
        let length = metadata.len();
        let mut reset = true;
        if let Some(entry) = self.cache.get(file) {
            reset = length < entry.offset
                || entry
                    .stamp
                    .as_ref()
                    .is_none_or(|old| !old.same_identity(&stamp));
            if !reset
                && length == entry.offset
                && entry.stamp.as_ref().and_then(|old| old.modified) != stamp.modified
            {
                reset = true;
            }
            if !reset && length > entry.offset && entry.offset > 0 {
                let prefix = read_slice(
                    &mut handle,
                    0,
                    entry.prefix.len() as u64,
                    &mut self.journal_bytes_read,
                )?;
                let tail = read_slice(
                    &mut handle,
                    entry.offset - entry.tail.len() as u64,
                    entry.tail.len() as u64,
                    &mut self.journal_bytes_read,
                )?;
                if prefix != entry.prefix || tail != entry.tail {
                    reset = true;
                }
            }
        }
        let entry = self.cache.entry(file.to_owned()).or_default();
        if reset {
            *entry = JournalCache::default();
        }
        if length > entry.offset {
            let bytes = read_slice(
                &mut handle,
                entry.offset,
                length - entry.offset,
                &mut self.journal_bytes_read,
            )?;
            let received = bytes.len() as u64;
            entry.remainder.extend_from_slice(&bytes);
            if let Some(newline) = entry.remainder.iter().rposition(|byte| *byte == b'\n') {
                for line in entry.remainder[..newline].split(|byte| *byte == b'\n') {
                    if line.iter().all(u8::is_ascii_whitespace) {
                        continue;
                    }
                    match serde_json::from_slice::<Value>(line) {
                        Ok(record) => entry.records.push(retained_record(record)),
                        Err(_) => entry.malformed += 1,
                    }
                }
                entry.remainder.drain(..=newline);
            }
            entry.offset += received;
            entry.parsed = None;
            entry.prefix = read_slice(
                &mut handle,
                0,
                entry.offset.min(128),
                &mut self.journal_bytes_read,
            )?;
            entry.tail = read_slice(
                &mut handle,
                entry.offset.saturating_sub(64),
                entry.offset.min(64),
                &mut self.journal_bytes_read,
            )?;
        }
        entry.stamp = Some(stamp);
        Ok(entry)
    }
}

fn nonempty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn default_home() -> PathBuf {
    #[cfg(windows)]
    let names = ["USERPROFILE", "HOME"];
    #[cfg(not(windows))]
    let names = ["HOME", "USERPROFILE"];
    names
        .iter()
        .find_map(|name| std::env::var_os(name).filter(|value| !value.is_empty()))
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn absolute_normalized(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut result = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            component => result.push(component.as_os_str()),
        }
    }
    result
}

fn inside(root: &Path, file: &Path) -> bool {
    #[cfg(windows)]
    {
        let root = root
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_lowercase();
        let file = file.to_string_lossy().replace('\\', "/").to_lowercase();
        file.strip_prefix(&root)
            .is_some_and(|rest| rest.starts_with('/') && rest.len() > 1)
    }
    #[cfg(not(windows))]
    {
        file != root && file.starts_with(root)
    }
}

fn read_slice(
    handle: &mut File,
    start: u64,
    length: u64,
    counter: &mut u64,
) -> io::Result<Vec<u8>> {
    let length = usize::try_from(length)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "journal-too-large"))?;
    let mut bytes = vec![0; length];
    handle.seek(SeekFrom::Start(start))?;
    let mut received = 0;
    while received < length {
        let count = handle.read(&mut bytes[received..])?;
        if count == 0 {
            break;
        }
        received += count;
    }
    bytes.truncate(received);
    *counter += received as u64;
    Ok(bytes)
}

fn missing_path(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound || error.kind() == io::ErrorKind::NotADirectory
}

fn unavailable(session: &Value, source: &str) -> Value {
    let mut session = session.clone();
    session["status"] = json!("unknown");
    session["currentTool"] = Value::Null;
    session["statusSource"] = json!(source);
    session
}

fn parse_time(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.timestamp_millis())
}

fn iso_time(now: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(now)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Keep only data required by the interpreter. Timestamps remain on discarded
/// record bodies so they still count toward the most recent journal event.
fn retained_record(mut record: Value) -> Value {
    let kind = record["type"].as_str().unwrap_or("").to_owned();
    let Some(payload) = record.get_mut("payload").and_then(Value::as_object_mut) else {
        return record;
    };
    if kind == "response_item" {
        let payload_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
        if payload_type == "reasoning"
            || (payload_type == "message"
                && (payload.get("role").and_then(Value::as_str) == Some("user")
                    || payload.get("channel").and_then(Value::as_str) == Some("analysis")))
        {
            payload.clear();
        } else if matches!(
            payload_type,
            "function_call_output" | "custom_tool_call_output"
        ) {
            if let Some(output) = payload.get_mut("output") {
                let object = output
                    .as_str()
                    .and_then(|text| serde_json::from_str::<Value>(text).ok())
                    .unwrap_or_else(|| output.clone());
                if object.is_object() {
                    let mut safe = Map::new();
                    for key in ["isError", "exit_code", "exitCode"] {
                        if let Some(value) = object.get(key) {
                            safe.insert(key.to_owned(), value.clone());
                        }
                    }
                    *output = Value::Object(safe);
                } else {
                    *output = Value::Null;
                }
            }
        }
    } else if kind == "event_msg" {
        if let Some(item) = payload.get_mut("item").and_then(Value::as_object_mut) {
            for key in ["aggregated_output", "output", "stdout", "stderr"] {
                item.remove(key);
            }
            if item.get("phase").and_then(Value::as_str) == Some("analysis") {
                item.remove("content");
            }
        }
    }
    record
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    struct Fixture {
        directory: TempDir,
        database: Connection,
        monitor: Monitor,
        now: i64,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            fs::create_dir(directory.path().join("sessions")).unwrap();
            fs::create_dir(directory.path().join("archived_sessions")).unwrap();
            let database = Connection::open(directory.path().join("state_5.sqlite")).unwrap();
            database.execute_batch("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, cwd TEXT, updated_at INTEGER, updated_at_ms INTEGER, source TEXT, archived INTEGER DEFAULT 0)").unwrap();
            let monitor = Monitor::new(Some(directory.path().to_owned()), 80);
            Self {
                directory,
                database,
                monitor,
                now: Utc::now().timestamp_millis(),
            }
        }

        fn add(
            &self,
            id: &str,
            records: Option<Vec<Value>>,
            file: Option<PathBuf>,
            archived: bool,
        ) -> PathBuf {
            let file = file.unwrap_or_else(|| {
                self.directory
                    .path()
                    .join("sessions")
                    .join(format!("{id}.jsonl"))
            });
            if let Some(records) = records {
                write_records(&file, &records);
            }
            self.database.execute("INSERT INTO threads (id,rollout_path,title,cwd,updated_at,updated_at_ms,source,archived) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", rusqlite::params![
                id, file.to_string_lossy(), "Пробный чат", self.directory.path().to_string_lossy(), self.now / 1000, self.now, "vscode", archived as i64,
            ]).unwrap();
            file
        }

        fn started(&self) -> Value {
            record(
                "event_msg",
                json!({"type":"task_started", "turn_id":"turn"}),
                self.now,
            )
        }

        fn completed(&self) -> Value {
            record(
                "event_msg",
                json!({"type":"task_complete", "turn_id":"turn"}),
                self.now,
            )
        }

        fn state(&mut self) -> Value {
            self.monitor.get_state_at(self.now)
        }
    }

    fn record(kind: &str, payload: Value, now: i64) -> Value {
        json!({"type": kind, "payload":payload, "timestamp":iso_time(now)})
    }

    fn catalog(now: i64) -> Value {
        record(
            "world_state",
            json!({"full":true,"state":{"host_skills":{"body":"### Available skills\n- пример: Test skill. (file: C:/skills/пример/SKILL.md)\n"}}}),
            now,
        )
    }

    fn write_records(file: &Path, records: &[Value]) {
        let mut handle = File::create(file).unwrap();
        for record in records {
            writeln!(handle, "{record}").unwrap();
        }
    }

    fn append(file: &Path, bytes: &[u8]) {
        fs::OpenOptions::new()
            .append(true)
            .open(file)
            .unwrap()
            .write_all(bytes)
            .unwrap();
    }

    #[test]
    fn reads_unicode_catalog_and_does_not_write_database() {
        let mut f = Fixture::new();
        f.add(
            "one",
            Some(vec![
                f.started(),
                catalog(f.now),
                record(
                    "turn_context",
                    json!({"model":"example-model","turn_id":"turn"}),
                    f.now,
                ),
            ]),
            None,
            false,
        );
        let before = fs::read(f.directory.path().join("state_5.sqlite")).unwrap();
        let state = f.state();
        assert_eq!(state["source"]["health"], "ok");
        assert_eq!(state["warnings"], json!([]));
        assert_eq!(state["sessions"][0]["status"], "active");
        assert_eq!(state["sessions"][0]["skills"][0]["name"], "пример");
        assert_eq!(state["sessions"][0]["model"], "example-model");
        assert_eq!(
            fs::read(f.directory.path().join("state_5.sqlite")).unwrap(),
            before
        );
    }

    #[test]
    fn incremental_reader_preserves_a_partial_utf8_character() {
        let mut f = Fixture::new();
        let file = f.add("one", Some(vec![f.started()]), None, false);
        let line = format!("{}\n", catalog(f.now)).into_bytes();
        let start = line
            .windows("пример".len())
            .position(|bytes| bytes == "пример".as_bytes())
            .unwrap();
        append(&file, &line[..start + 1]);
        assert_eq!(f.state()["sessions"][0]["skills"], json!([]));
        append(&file, &line[start + 1..]);
        let state = f.state();
        assert_eq!(state["sessions"][0]["skills"][0]["name"], "пример");
        assert_eq!(state["source"]["malformedRecords"], 0);
    }

    #[test]
    fn unchanged_polls_read_no_bytes_and_growth_only_reads_the_append_and_probes() {
        let mut f = Fixture::new();
        let mut records = vec![f.started()];
        records.extend((0..400).map(|_| {
            record(
                "response_item",
                json!({"type":"reasoning", "encrypted_content":"x".repeat(400)}),
                f.now,
            )
        }));
        let file = f.add("one", Some(records), None, false);
        f.state();
        let before = f.monitor.journal_bytes_read;
        f.state();
        assert_eq!(f.monitor.journal_bytes_read, before);
        append(&file, format!("{}\n", f.completed()).as_bytes());
        assert_eq!(f.state()["sessions"][0]["status"], "idle");
        assert!(f.monitor.journal_bytes_read - before < 1_500);
    }

    #[test]
    fn cached_active_status_expires_even_when_file_has_not_changed() {
        let mut f = Fixture::new();
        f.add("one", Some(vec![f.started()]), None, false);
        assert_eq!(f.state()["sessions"][0]["status"], "active");
        let state = f.monitor.get_state_at(f.now + STALE_MS + 1);
        assert_eq!(state["sessions"][0]["status"], "unknown");
        assert_eq!(state["sessions"][0]["statusSource"], "stale-active-event");
        assert!(state["sessions"][0]["currentTool"].is_null());
    }

    #[test]
    fn missing_journals_are_information_and_keep_a_previous_session_unknown() {
        let mut f = Fixture::new();
        let file = f.add("one", Some(vec![f.started()]), None, false);
        f.add("gone", None, None, false);
        assert_eq!(f.state()["sessions"][0]["status"], "active");
        fs::remove_file(file).unwrap();
        let state = f.state();
        assert_eq!(state["source"]["health"], "ok");
        assert_eq!(state["source"]["missingJournals"], 2);
        assert_eq!(state["warnings"], json!([]));
        assert_eq!(state["sessions"][0]["statusSource"], "journal-unavailable");
    }

    #[test]
    fn changed_schema_marks_previously_active_sessions_unknown() {
        let mut f = Fixture::new();
        f.add("one", Some(vec![f.started()]), None, false);
        f.state();
        f.database
            .execute_batch("ALTER TABLE threads RENAME COLUMN rollout_path TO changed_path")
            .unwrap();
        let state = f.state();
        assert_eq!(state["source"]["health"], "error");
        assert!(state["warnings"][0]
            .as_str()
            .unwrap()
            .contains("Формат базы Codex изменился"));
        assert_eq!(state["sessions"][0]["status"], "unknown");
        assert_eq!(
            state["sessions"][0]["statusSource"],
            "data-source-unavailable"
        );
    }

    #[test]
    fn rejects_outside_paths_and_allows_archived_tree_and_file_urls() {
        let mut f = Fixture::new();
        f.add(
            "outside",
            Some(vec![f.started()]),
            Some(f.directory.path().join("private.jsonl")),
            false,
        );
        let file = f.add(
            "archive",
            Some(vec![f.completed()]),
            Some(
                f.directory
                    .path()
                    .join("archived_sessions")
                    .join("one.jsonl"),
            ),
            false,
        );
        f.database
            .execute(
                "UPDATE threads SET rollout_path=?1 WHERE id='archive'",
                [url::Url::from_file_path(file).unwrap().to_string()],
            )
            .unwrap();
        f.add("hidden", Some(vec![f.started()]), None, true);
        let state = f.state();
        assert_eq!(state["source"]["rejectedJournals"], 1);
        assert_eq!(state["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(state["sessions"][0]["id"], "archive");
    }

    #[cfg(unix)]
    #[test]
    fn canonical_check_rejects_a_symlink_outside_journal_roots() {
        let mut f = Fixture::new();
        let outside = f.directory.path().join("private.jsonl");
        write_records(&outside, &[f.started()]);
        let link = f.directory.path().join("sessions").join("link.jsonl");
        std::os::unix::fs::symlink(outside, &link).unwrap();
        f.add("escape", None, Some(link), false);
        assert_eq!(f.state()["source"]["rejectedJournals"], 1);
    }

    #[test]
    fn truncation_and_a_larger_rewrite_reset_cache() {
        let mut f = Fixture::new();
        let file = f.add("one", Some(vec![f.started(), catalog(f.now)]), None, false);
        assert_eq!(
            f.state()["sessions"][0]["skills"].as_array().unwrap().len(),
            1
        );
        write_records(&file, &[f.completed()]);
        assert_eq!(f.state()["sessions"][0]["skills"], json!([]));
        write_records(&file, &[f.started(), catalog(f.now), catalog(f.now)]);
        assert_eq!(f.state()["sessions"][0]["status"], "active");
        assert_eq!(
            f.state()["sessions"][0]["skills"].as_array().unwrap().len(),
            1
        );
        f.monitor.close();
        f.database.execute_batch("DROP TABLE threads").unwrap();
        assert_eq!(f.state()["sessions"], json!([]));
    }

    #[test]
    fn malformed_complete_lines_do_not_block_following_records() {
        let mut f = Fixture::new();
        let file = f.add("one", Some(vec![f.started()]), None, false);
        append(
            &file,
            format!("{{broken json}}\n{}\n", f.completed()).as_bytes(),
        );
        let state = f.state();
        assert_eq!(state["sessions"][0]["status"], "idle");
        assert_eq!(state["source"]["malformedRecords"], 1);
        assert_eq!(state["warnings"], json!([]));
    }

    #[test]
    fn does_not_return_messages_reasoning_commands_or_tool_output() {
        let mut f = Fixture::new();
        f.add("one", Some(vec![
            f.started(),
            record("response_item", json!({"type":"message","role":"user","content":[{"type":"input_text","text":"PRIVATE_USER"}]}), f.now),
            record("response_item", json!({"type":"reasoning","summary":[{"text":"PRIVATE_REASONING"}]}), f.now),
            record("event_msg", json!({"type":"item_completed","item":{"type":"CommandExecution","id":"cmd","status":"completed","exit_code":0,"command":"Write-Output PRIVATE_COMMAND","aggregated_output":"PRIVATE_OUTPUT","parsed_cmd":[]}}), f.now),
        ]), None, false);
        assert!(!f.state().to_string().contains("PRIVATE_"));
        let cached = f.monitor.cache.values().next().unwrap();
        let stored = serde_json::to_string(&cached.records).unwrap();
        assert!(!stored.contains("PRIVATE_USER"));
        assert!(!stored.contains("PRIVATE_REASONING"));
        assert!(!stored.contains("PRIVATE_OUTPUT"));
    }

    #[test]
    fn stripping_unused_bodies_preserves_parser_regression_cases() {
        let cases: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/parser-migration.json"))
                .unwrap();
        for case in cases.as_array().unwrap() {
            let Some(records) = case["records"].as_array() else {
                continue;
            };
            let retained: Vec<Value> = records.iter().cloned().map(retained_record).collect();
            assert_eq!(
                crate::parser::parse_session_records(&retained, &case["metadata"]),
                crate::parser::parse_session_records(records, &case["metadata"]),
                "retained data changed {}",
                case["name"],
            );
        }
    }

    #[test]
    fn honors_limit_and_uses_highest_database_version() {
        let mut f = Fixture::new();
        f.add("one", Some(vec![f.started()]), None, false);
        f.add("two", Some(vec![f.started()]), None, false);
        f.monitor.limit = 1;
        assert_eq!(f.state()["sessions"].as_array().unwrap().len(), 1);
        fs::copy(
            f.directory.path().join("state_5.sqlite"),
            f.directory.path().join("state_12.sqlite"),
        )
        .unwrap();
        fs::write(f.directory.path().join("state_9.sqlite"), b"not a database").unwrap();
        assert_eq!(f.state()["source"]["health"], "ok");
        let mut absent = Monitor::new(Some(f.directory.path().join("missing-home")), 80);
        assert_eq!(absent.get_state()["source"]["health"], "error");
    }

    #[test]
    fn supports_schema_without_optional_columns_and_rejects_path_siblings() {
        let mut f = Fixture::new();
        f.add("one", Some(vec![f.completed()]), None, false);
        f.database.execute_batch("ALTER TABLE threads DROP COLUMN archived; ALTER TABLE threads DROP COLUMN source; ALTER TABLE threads DROP COLUMN updated_at_ms;").unwrap();
        assert_eq!(f.state()["source"]["health"], "ok");
        let sibling = f.directory.path().join("sessions-private");
        fs::create_dir(&sibling).unwrap();
        let outside = sibling.join("escape.jsonl");
        write_records(&outside, &[f.started()]);
        assert!(f.monitor.allowed_file(outside.to_str()).unwrap().is_none());
    }
}
