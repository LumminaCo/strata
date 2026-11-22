#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use strata_app::{AppService, Health};

#[tauri::command]
fn health(app: tauri::State<'_, AppService>) -> Health {
    app.health()
}

fn main() -> tauri::Result<()> {
    tauri::Builder::default()
        .manage(AppService)
        .invoke_handler(tauri::generate_handler![health])
        .run(tauri::generate_context!())
}
