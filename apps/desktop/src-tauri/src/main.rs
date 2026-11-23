#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod benchmark;
mod updater;

use benchmark::{Benchmark, benchmark_sample};
use serde_json::Value;
use strata_app::{AppService, Command, ErrorDto, Health, RunEvent, RunRequest};
use tauri::{State, ipc::Channel};
use tokio_util::sync::CancellationToken;
use updater::{AppActivity, PendingUpdate, check_update, install_update};

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
        .manage(benchmark)
        .manage(AppService::open(true)?)
        .manage(AppActivity::default())
        .manage(PendingUpdate::default())
        .invoke_handler(tauri::generate_handler![
            health,
            dispatch,
            run_query,
            check_update,
            install_update,
            benchmark_sample
        ])
        .run(context)?;
    Ok(())
}
