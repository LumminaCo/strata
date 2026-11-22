#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod benchmark;

use benchmark::{Benchmark, benchmark_sample};
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
    let mut builder = tauri::Builder::default();
    if benchmark.enabled() {
        builder = builder.plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("benchmark")
                .js_init_script(include_str!("../../../../dev/benchmark-webview.js"))
                .build(),
        );
    }
    builder
        .manage(benchmark)
        .manage(AppService::open(true)?)
        .invoke_handler(tauri::generate_handler![
            health,
            dispatch,
            run_query,
            benchmark_sample
        ])
        .run(tauri::generate_context!())?;
    Ok(())
}
