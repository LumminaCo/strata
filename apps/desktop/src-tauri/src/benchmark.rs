use std::{fs::File, io::Write, sync::Mutex};

use serde_json::Value;
use tauri::State;

pub struct Benchmark(Option<Mutex<File>>);

impl Benchmark {
    pub fn open() -> std::io::Result<Self> {
        let output = std::env::var_os("STRATA_BENCHMARK_LOG")
            .map(|path| File::options().append(true).open(path).map(Mutex::new))
            .transpose()?;
        Ok(Self(output))
    }

    pub fn enabled(&self) -> bool {
        self.0.is_some()
    }
}

#[tauri::command]
pub fn benchmark_sample(state: State<'_, Benchmark>, sample: Value) -> Result<(), String> {
    let file = state.0.as_ref().ok_or("Benchmark is disabled")?;
    writeln!(file.lock().map_err(|error| error.to_string())?, "{sample}")
        .map_err(|error| error.to_string())
}
