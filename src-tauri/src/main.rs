#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = skill_desk::shell::run() {
        // Keep a useful diagnostic for launch from a terminal.
        eprintln!("Skill Desk: {error}");
        std::process::exit(1);
    }
}
