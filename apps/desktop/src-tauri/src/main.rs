#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;
use strata_app::{AppService, Command, ErrorDto, Health, RunEvent, RunRequest};
use tauri::{State, ipc::Channel};
use tokio_util::sync::CancellationToken;

#[tauri::command]
fn health(app: State<'_, AppService>) -> Health {
    app.health()
}

#[tauri::command]
async fn dispatch(app: State<'_, AppService>, request: Command) -> Result<Value, ErrorDto> {
    app.dispatch(request, CancellationToken::new()).await
}

#[tauri::command]
async fn run_query(
    app: State<'_, AppService>,
    request: RunRequest,
    channel: Channel<RunEvent>,
) -> Result<(), ErrorDto> {
    app.run(request, |event| {
        std::future::ready(channel.send(event).is_ok())
    })
    .await
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    tauri::Builder::default()
        .manage(AppService::open(true)?)
        .invoke_handler(tauri::generate_handler![health, dispatch, run_query])
        .run(tauri::generate_context!())?;
    Ok(())
}
