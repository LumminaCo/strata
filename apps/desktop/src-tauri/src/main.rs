#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod benchmark;
mod sql_file;
mod updater;

use benchmark::{Benchmark, benchmark_sample};
use serde_json::Value;
use sql_file::{open_sql_file, save_sql_file};
use strata_app::{AppService, Command, ErrorDto, Health, RunEvent, RunRequest};
#[cfg(target_os = "linux")]
use tauri::Manager;
use tauri::{State, ipc::Channel};
use tokio_util::sync::CancellationToken;
use updater::{AppActivity, PendingUpdate, check_update, install_update};

#[cfg(any(target_os = "linux", test))]
fn wayland_activation_token<'a>(
    desktop_startup_id: Option<&'a str>,
    xdg_activation_token: Option<&'a str>,
) -> Option<&'a str> {
    if desktop_startup_id.is_some_and(|id| !id.is_empty()) {
        return None;
    }
    xdg_activation_token.filter(|token| !token.is_empty())
}

#[cfg(target_os = "linux")]
fn apply_wayland_activation_token(app: &tauri::App) {
    use gtk::prelude::GtkWindowExt;

    let desktop_startup_id = std::env::var("DESKTOP_STARTUP_ID").ok();
    let xdg_activation_token = std::env::var("XDG_ACTIVATION_TOKEN").ok();
    let Some(token) = wayland_activation_token(
        desktop_startup_id.as_deref(),
        xdg_activation_token.as_deref(),
    ) else {
        return;
    };
    if let Some(window) = app.get_webview_window("main")
        && let Ok(gtk_window) = window.gtk_window()
    {
        // GTK 3 only reads DESKTOP_STARTUP_ID from the environment; forward
        // XDG_ACTIVATION_TOKEN so Wayland compositors clear the launch cursor.
        gtk_window.set_startup_id(token);
    }
}

#[tauri::command]
fn health(app: State<'_, AppService>) -> Health {
    app.health()
}

#[tauri::command]
async fn dispatch(
    app: State<'_, AppService>,
    activity: State<'_, AppActivity>,
    request: Command,
) -> Result<Value, ErrorDto> {
    let _operation = activity.begin_operation()?;
    app.dispatch(request, CancellationToken::new()).await
}

#[tauri::command]
async fn run_query(
    app: State<'_, AppService>,
    activity: State<'_, AppActivity>,
    request: RunRequest,
    channel: Channel<RunEvent>,
) -> Result<(), ErrorDto> {
    let _operation = activity.begin_operation()?;
    app.run(request, |event| {
        std::future::ready(channel.send(event).is_ok())
    })
    .await
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args().skip(1);
    match arguments.next().as_deref() {
        Some("mcp") => {
            let mut only = std::collections::HashSet::new();
            while let Some(argument) = arguments.next() {
                if argument != "--only" {
                    return Err("Use strata mcp [--only <connection-name>]".into());
                }
                let names = arguments
                    .next()
                    .ok_or("--only requires a connection name")?;
                let names: Vec<_> = names
                    .split(',')
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .collect();
                if names.is_empty() {
                    return Err("--only requires a connection name".into());
                }
                only.extend(names.into_iter().map(str::to_owned));
            }
            return tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?
                .block_on(strata_mcp::serve(only));
        }
        Some("--version") => {
            println!("Strata {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        Some(_) => return Err("Use strata, strata --version, or strata mcp".into()),
        None => {}
    }
    let benchmark = Benchmark::open()?;
    let context = tauri::generate_context!();
    let mut builder = tauri::Builder::default();
    if benchmark.enabled() {
        builder = builder.plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("benchmark")
                .js_init_script(include_str!("../../../../dev/benchmark-webview.js"))
                .build(),
        );
    }
    if updater::is_configured(context.config()) {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            #[cfg(target_os = "linux")]
            apply_wayland_activation_token(_app);
            Ok(())
        })
        .manage(benchmark)
        .manage(AppService::open(true)?)
        .manage(AppActivity::default())
        .manage(PendingUpdate::default())
        .invoke_handler(tauri::generate_handler![
            health,
            dispatch,
            run_query,
            open_sql_file,
            save_sql_file,
            check_update,
            install_update,
            benchmark_sample
        ])
        .run(context)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::wayland_activation_token;

    #[test]
    fn forwards_xdg_activation_token_when_desktop_startup_id_is_missing() {
        assert_eq!(
            wayland_activation_token(None, Some("token-123")),
            Some("token-123")
        );
        assert_eq!(
            wayland_activation_token(Some(""), Some("token-123")),
            Some("token-123")
        );
    }

    #[test]
    fn skips_forwarding_when_desktop_startup_id_is_present_or_token_empty() {
        assert_eq!(
            wayland_activation_token(Some("startup-id"), Some("token-123")),
            None
        );
        assert_eq!(wayland_activation_token(None, None), None);
        assert_eq!(wayland_activation_token(None, Some("")), None);
    }
}
