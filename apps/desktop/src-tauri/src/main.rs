#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    claim_guard_desktop_lib::run();
}
