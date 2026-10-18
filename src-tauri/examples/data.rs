//! Development-only data inspection and browser preview. The desktop app does not run a server.
use serde_json::{json, Value};
use skill_desk::{monitor::Monitor, parser};
use std::{
    io::{Read, Write},
    net::TcpListener,
    time::Duration,
};

fn main() {
    if let Err(error) = run() {
        eprintln!("Skill Desk data: {error}");
        std::process::exit(1);
    }
}

fn input() -> Result<Value, Box<dyn std::error::Error>> {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text)?;
    Ok(serde_json::from_str(&text)?)
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    match std::env::args().nth(1).as_deref() {
        Some("--parse") => {
            let value = input()?;
            let records = value["records"]
                .as_array()
                .ok_or("records must be an array")?;
            println!(
                "{}",
                parser::parse_session_records(records, &value["metadata"])
            );
        }
        Some("--catalog") => {
            let value = input()?;
            let records = vec![
                json!({"type":"world_state","payload":{"full":true,"state":{"host_skills":{"body":value["text"]}}}}),
            ];
            let result = parser::parse_session_records(&records, &json!({}));
            let catalog: Vec<Value> = result["skills"].as_array().unwrap().iter()
                .map(|s| json!({"id":s["id"], "name":s["name"],"description":s["description"],"path":s["path"]})).collect();
            println!("{}", json!(catalog));
        }
        Some("--preview") => preview()?,
        Some("--once") | None => println!("{}", Monitor::new(None, 80).get_state()),
        _ => return Err("Use --once, --preview, --parse, or --catalog".into()),
    }
    Ok(())
}

fn preview() -> Result<(), Box<dyn std::error::Error>> {
    let port = std::env::var("SKILL_DESK_PREVIEW_PORT")
        .unwrap_or_else(|_| "47832".into())
        .parse::<u16>()?;
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    let mut monitor = Monitor::new(None, 80);
    println!("Skill Desk preview: http://127.0.0.1:{port}");
    for connection in listener.incoming() {
        let mut stream = connection?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        let mut request = Vec::new();
        loop {
            let mut chunk = [0; 1024];
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => request.extend_from_slice(&chunk[..n]),
            }
            if request.windows(4).any(|b| b == b"\r\n\r\n") || request.len() >= 8192 {
                break;
            }
        }
        let request = String::from_utf8_lossy(&request);
        let first = request
            .lines()
            .next()
            .unwrap_or_default()
            .split_whitespace()
            .collect::<Vec<_>>();
        let host = request.lines().skip(1).find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("host").then(|| value.trim())
        });
        let valid =
            first.first() == Some(&"GET") && host == Some(format!("127.0.0.1:{port}").as_str());
        let route = first
            .get(1)
            .copied()
            .unwrap_or("/")
            .split('?')
            .next()
            .unwrap_or("/");
        let (status, mime, body): (&str, &str, Vec<u8>) = if !valid {
            ("403 Forbidden", "text/plain", b"Forbidden".to_vec())
        } else {
            match route {
                "/" | "/index.html" => (
                    "200 OK",
                    "text/html; charset=utf-8",
                    include_bytes!("../../ui/index.html").to_vec(),
                ),
                "/app.js" => (
                    "200 OK",
                    "text/javascript; charset=utf-8",
                    include_bytes!("../../ui/app.js").to_vec(),
                ),
                "/native.js" => (
                    "200 OK",
                    "text/javascript; charset=utf-8",
                    include_bytes!("../../ui/native.js").to_vec(),
                ),
                "/style.css" => (
                    "200 OK",
                    "text/css; charset=utf-8",
                    include_bytes!("../../ui/style.css").to_vec(),
                ),
                "/assets/icon.svg" => (
                    "200 OK",
                    "image/svg+xml",
                    include_bytes!("../../ui/assets/icon.svg").to_vec(),
                ),
                "/api/state" => (
                    "200 OK",
                    "application/json; charset=utf-8",
                    serde_json::to_vec(&monitor.get_state())?,
                ),
                _ => ("404 Not Found", "text/plain", b"Not found".to_vec()),
            }
        };
        let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n", body.len());
        let _ = stream.write_all(&body);
    }
    Ok(())
}
