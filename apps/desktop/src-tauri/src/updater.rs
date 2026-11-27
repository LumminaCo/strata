use std::time::Duration;

use strata_app::{AppService, ErrorDto};
use tauri::{AppHandle, State, ipc::Channel};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::{Mutex, RwLock, RwLockReadGuard, RwLockWriteGuard};

#[derive(Default)]
pub struct AppActivity(RwLock<()>);

impl AppActivity {
    pub fn begin_operation(&self) -> Result<RwLockReadGuard<'_, ()>, ErrorDto> {
        self.0.try_read().map_err(|_| ErrorDto {
            kind: "config".into(),
            message: "Wait for the Strata update to finish.".into(),
            code: None,
            position: None,
            line: None,
        })
    }

    fn begin_installation(&self) -> Result<RwLockWriteGuard<'_, ()>, &'static str> {
        self.0.try_write().map_err(|_| {
            "A query or another operation is still running. Wait for it to finish, then click Update again."
        })
    }
}

#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

/// Returns whether the signed updater plugin configuration is present in `tauri.conf.json`.
pub fn is_configured(config: &tauri::Config) -> bool {
    config.plugins.0.contains_key("updater")
}

#[tauri::command]
pub async fn check_update(
    handle: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<String>, String> {
    if !is_configured(handle.config()) {
        return Ok(None);
    }

    let mut pending = pending.0.lock().await;
    *pending = handle
        .updater_builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| format!("Could not check for updates. {error}"))?;
    Ok(pending.as_ref().map(|update| update.version.clone()))
}

#[tauri::command]
pub async fn install_update(
    handle: AppHandle,
    app: State<'_, AppService>,
    activity: State<'_, AppActivity>,
    pending: State<'_, PendingUpdate>,
    channel: Channel<&'static str>,
) -> Result<(), String> {
    let _installation = activity.begin_installation()?;
    if app
        .has_open_transactions()
        .await
        .map_err(|error| error.message)?
    {
        return Err("Commit or roll back open transactions before updating Strata.".into());
    }

    let mut update = pending
        .0
        .lock()
        .await
        .clone()
        .ok_or("No Strata update is available.")?;
    update.timeout = Some(Duration::from_secs(180));
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| format!("Could not download or verify the update. {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        check_other_processes()?;
        let _ = channel.send("Installing update…");
        update
            .install(bytes)
            .map_err(|error| format!("Could not install the update. {error}"))
    })
    .await
    .map_err(|error| error.to_string())??;
    // On Windows the installer takes over and relaunches the app.
    // On macOS and Linux keep the gate held until this process exits.
    handle.restart();
}

#[cfg(windows)]
fn check_other_processes() -> Result<(), String> {
    use std::{env, os::windows::process::CommandExt, path::PathBuf, process::Command};

    // The passive NSIS installer can forcibly close other processes using strata-desktop.exe.
    // Give other Strata windows a chance to finish their work first.
    const CHECK_FAILED: &str = "Could not check for other running copies of Strata.";
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let exe = env::current_exe().map_err(|_| CHECK_FAILED)?;
    let name = exe
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(CHECK_FAILED)?;
    let tasklist = PathBuf::from(env::var_os("SystemRoot").ok_or(CHECK_FAILED)?)
        .join("System32")
        .join("tasklist.exe");
    let result = Command::new(tasklist)
        .args(["/fi", &format!("IMAGENAME eq {name}"), "/fo", "csv", "/nh"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|_| CHECK_FAILED)?;
    if !result.status.success() {
        return Err(CHECK_FAILED.into());
    }
    match String::from_utf8_lossy(&result.stdout)
        .lines()
        .filter(|line| line.starts_with('"'))
        .count()
    {
        1 => Ok(()),
        0 => Err(CHECK_FAILED.into()),
        _ => Err("Another Strata window is running. Close it before updating.".into()),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{AppActivity, is_configured};

    #[test]
    fn updater_configuration_tracks_plugin_presence() {
        let unsigned = tauri::Config::default();
        assert!(!is_configured(&unsigned));

        let mut signed = tauri::Config::default();
        signed.plugins.0.insert(
            "updater".into(),
            json!({
                "pubkey": "test-key",
                "endpoints": ["https://example.com/latest.json"]
            }),
        );
        assert!(is_configured(&signed));
    }

    #[test]
    fn installation_and_database_operations_are_mutually_exclusive() {
        let activity = AppActivity::default();
        let query = activity.begin_operation().unwrap();
        let fetch = activity.begin_operation().unwrap();
        assert!(activity.begin_installation().is_err());
        drop(query);
        assert!(activity.begin_installation().is_err());
        drop(fetch);

        let installation = activity.begin_installation().unwrap();
        assert!(activity.begin_operation().is_err());
        assert!(activity.begin_installation().is_err());
        drop(installation);
        assert!(activity.begin_operation().is_ok());
    }
}
