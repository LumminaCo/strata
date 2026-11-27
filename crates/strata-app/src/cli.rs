use std::{
    env, fs,
    path::{Path, PathBuf},
};

use directories::{BaseDirs, ProjectDirs};
use serde::Serialize;
use serde_json::{Value, json};
use strata_core::{CoreError, Result};
use tempfile::NamedTempFile;
use ts_rs::TS;

const VERSION_STAMP: &str = ".version";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub installed: bool,
    pub on_path: bool,
    pub needs_update: bool,
    pub bundled_available: bool,
    pub ephemeral: bool,
    pub path: Option<String>,
    pub install_dir: Option<String>,
}

fn cli_binary_name() -> &'static str {
    if cfg!(windows) {
        "strata.exe"
    } else {
        "strata"
    }
}

fn oracle_bridge_name() -> &'static str {
    if cfg!(windows) {
        "oracle-bridge.exe"
    } else {
        "oracle-bridge"
    }
}

fn is_ephemeral_exe(exe: &Path, appimage_env: Option<&std::ffi::OsStr>) -> bool {
    if appimage_env.is_some_and(|value| !value.is_empty()) {
        return true;
    }
    exe.to_string_lossy().contains("/.mount_")
}

fn bundled_cli_path() -> Option<PathBuf> {
    if let Some(path) = env::var_os("STRATA_CLI_BIN").filter(|value| !value.is_empty()) {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let exe = env::current_exe().ok()?;
    let candidate = exe.with_file_name(cli_binary_name());
    if candidate.is_file() {
        return Some(candidate);
    }
    if let Ok(canonical) = fs::canonicalize(&exe) {
        let candidate = canonical.with_file_name(cli_binary_name());
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn managed_bin_dir() -> Option<PathBuf> {
    if let Some(root) = env::var_os("STRATA_HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(root).join("bin"));
    }
    #[cfg(windows)]
    {
        BaseDirs::new().map(|dirs| dirs.data_local_dir().join("Strata").join("bin"))
    }
    #[cfg(not(windows))]
    {
        ProjectDirs::from("co", "Lummina", "Strata").map(|dirs| dirs.data_local_dir().join("bin"))
    }
}

fn user_bin_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        managed_bin_dir()
    }
    #[cfg(not(windows))]
    {
        let base = BaseDirs::new()?;
        base.executable_dir()
            .map(Path::to_path_buf)
            .or_else(|| Some(base.home_dir().join(".local").join("bin")))
    }
}

fn path_contains_dir(path_var: Option<&std::ffi::OsStr>, dir: &Path) -> bool {
    let Some(path_var) = path_var else {
        return false;
    };
    let canonical_dir = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    env::split_paths(path_var).any(|entry| {
        if entry == dir {
            return true;
        }
        let canonical_entry = fs::canonicalize(&entry).unwrap_or(entry);
        #[cfg(windows)]
        {
            canonical_entry
                .to_string_lossy()
                .eq_ignore_ascii_case(&canonical_dir.to_string_lossy())
        }
        #[cfg(not(windows))]
        {
            canonical_entry == canonical_dir
        }
    })
}

fn managed_needs_update(managed_dir: &Path, current_version: &str) -> bool {
    let binary = managed_dir.join(cli_binary_name());
    if !binary.is_file() {
        return false;
    }
    match fs::read_to_string(managed_dir.join(VERSION_STAMP)) {
        Ok(version) => version.trim() != current_version,
        Err(_) => true,
    }
}

fn copy_executable(source: &Path, target: &Path) -> Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| CoreError::config("CLI destination has no parent directory"))?;
    fs::create_dir_all(parent).map_err(io_error)?;
    let mut temp = NamedTempFile::new_in(parent).map_err(io_error)?;
    let mut input = fs::File::open(source).map_err(io_error)?;
    std::io::copy(&mut input, temp.as_file_mut()).map_err(io_error)?;
    temp.as_file().sync_all().map_err(io_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::Permissions::from_mode(0o755);
        fs::set_permissions(temp.path(), permissions).map_err(io_error)?;
    }
    temp.persist(target).map_err(io_error)?;
    Ok(())
}

fn copy_managed_binaries(
    bundled_cli: &Path,
    managed_dir: &Path,
    current_version: &str,
) -> Result<PathBuf> {
    fs::create_dir_all(managed_dir).map_err(io_error)?;
    let target_cli = managed_dir.join(cli_binary_name());
    copy_executable(bundled_cli, &target_cli)?;
    let bundled_bridge = bundled_cli.with_file_name(oracle_bridge_name());
    if bundled_bridge.is_file() {
        let target_bridge = managed_dir.join(oracle_bridge_name());
        copy_executable(&bundled_bridge, &target_bridge)?;
    }
    fs::write(
        managed_dir.join(VERSION_STAMP),
        format!("{current_version}\n"),
    )
    .map_err(io_error)?;
    Ok(target_cli)
}

#[cfg(unix)]
fn install_unix_symlink(target: &Path, link_path: &Path) -> Result<()> {
    let parent = link_path
        .parent()
        .ok_or_else(|| CoreError::config("CLI install directory is invalid"))?;
    fs::create_dir_all(parent).map_err(io_error)?;
    if let Ok(meta) = fs::symlink_metadata(link_path) {
        if !meta.file_type().is_symlink() {
            return Err(CoreError::config(format!(
                "Refusing to overwrite existing file at {}",
                link_path.display()
            )));
        }
        fs::remove_file(link_path).map_err(io_error)?;
    }
    std::os::unix::fs::symlink(target, link_path).map_err(io_error)?;
    Ok(())
}

#[cfg(windows)]
fn ensure_windows_user_path(bin_dir: &Path) -> Result<()> {
    use std::{os::windows::process::CommandExt, process::Command};
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let dir = bin_dir.to_string_lossy().into_owned();
    let script = r#"
$dir = $env:STRATA_PATH_ENTRY
$current = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @()
if ($current) { $parts = $current -split ';' | Where-Object { $_ -ne '' } }
if (-not ($parts | Where-Object { $_.TrimEnd('\') -ieq $dir.TrimEnd('\') })) {
  $updated = (@($parts) + $dir) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
}
"#;
    let status = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("STRATA_PATH_ENTRY", dir)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(io_error)?;
    if !status.success() {
        return Err(CoreError::Io {
            message: "Could not add Strata CLI to the user PATH".into(),
        });
    }
    Ok(())
}

fn inspect_status(
    bundled_cli: Option<&Path>,
    ephemeral: bool,
    user_bin: Option<&Path>,
    managed_dir: Option<&Path>,
    path_var: Option<&std::ffi::OsStr>,
    current_version: &str,
) -> CliStatus {
    let bundled_available = bundled_cli.is_some();
    let install_dir = user_bin.map(|dir| dir.to_string_lossy().into_owned());

    // System-packaged install (e.g. Debian /usr/bin/strata) is already installed on PATH.
    if !ephemeral
        && let Some(bundled) = bundled_cli
        && let Some(parent) = bundled.parent()
        && path_contains_dir(path_var, parent)
    {
        return CliStatus {
            installed: true,
            on_path: true,
            needs_update: false,
            bundled_available: true,
            ephemeral: false,
            path: Some(bundled.to_string_lossy().into_owned()),
            install_dir: Some(parent.to_string_lossy().into_owned()),
        };
    }

    if let Some(bin_dir) = user_bin {
        let installed_path = bin_dir.join(cli_binary_name());
        if installed_path.is_file() {
            let needs_update =
                managed_dir.is_some_and(|dir| managed_needs_update(dir, current_version));
            let on_path = path_contains_dir(path_var, bin_dir);
            return CliStatus {
                installed: true,
                on_path,
                needs_update,
                bundled_available,
                ephemeral,
                path: Some(installed_path.to_string_lossy().into_owned()),
                install_dir,
            };
        }
    }

    let fallback_path = if !ephemeral {
        bundled_cli.map(|path| path.to_string_lossy().into_owned())
    } else {
        None
    };

    CliStatus {
        installed: false,
        on_path: false,
        needs_update: false,
        bundled_available,
        ephemeral,
        path: fallback_path,
        install_dir,
    }
}

pub fn cli_status() -> CliStatus {
    let exe = env::current_exe().ok();
    let ephemeral = exe
        .as_deref()
        .is_some_and(|path| is_ephemeral_exe(path, env::var_os("APPIMAGE").as_deref()));
    let bundled = bundled_cli_path();
    let user_bin = user_bin_dir();
    let managed = managed_bin_dir();
    let path_var = env::var_os("PATH");
    inspect_status(
        bundled.as_deref(),
        ephemeral,
        user_bin.as_deref(),
        managed.as_deref(),
        path_var.as_deref(),
        env!("CARGO_PKG_VERSION"),
    )
}

fn install_cli_with(
    bundled_cli: &Path,
    ephemeral: bool,
    user_bin: &Path,
    managed_dir: &Path,
    path_var: Option<&std::ffi::OsStr>,
    current_version: &str,
) -> Result<CliStatus> {
    if !ephemeral
        && let Some(parent) = bundled_cli.parent()
        && path_contains_dir(path_var, parent)
    {
        return Ok(inspect_status(
            Some(bundled_cli),
            false,
            Some(user_bin),
            Some(managed_dir),
            path_var,
            current_version,
        ));
    }

    #[cfg(unix)]
    {
        let target = if ephemeral {
            copy_managed_binaries(bundled_cli, managed_dir, current_version)?
        } else {
            fs::canonicalize(bundled_cli).unwrap_or_else(|_| bundled_cli.to_path_buf())
        };
        let link_path = user_bin.join(cli_binary_name());
        install_unix_symlink(&target, &link_path)?;
    }

    #[cfg(windows)]
    {
        let _ = copy_managed_binaries(bundled_cli, managed_dir, current_version)?;
        ensure_windows_user_path(managed_dir)?;
    }

    Ok(inspect_status(
        Some(bundled_cli),
        ephemeral,
        Some(user_bin),
        Some(managed_dir),
        path_var,
        current_version,
    ))
}

pub fn install_cli() -> Result<CliStatus> {
    let bundled = bundled_cli_path()
        .ok_or_else(|| CoreError::config("The bundled Strata CLI executable is unavailable"))?;
    let exe = env::current_exe().ok();
    let ephemeral = exe
        .as_deref()
        .is_some_and(|path| is_ephemeral_exe(path, env::var_os("APPIMAGE").as_deref()));
    let user_bin = user_bin_dir()
        .ok_or_else(|| CoreError::config("Cannot determine the user CLI bin directory"))?;
    let managed = managed_bin_dir()
        .ok_or_else(|| CoreError::config("Cannot determine the Strata data directory"))?;
    let path_var = env::var_os("PATH");
    install_cli_with(
        &bundled,
        ephemeral,
        &user_bin,
        &managed,
        path_var.as_deref(),
        env!("CARGO_PKG_VERSION"),
    )
}

/// Best-effort refresh of a previously copied CLI binary after an app update.
pub fn sync_installed_cli() {
    let Some(bundled) = bundled_cli_path() else {
        return;
    };
    let Some(managed) = managed_bin_dir() else {
        return;
    };
    let version = env!("CARGO_PKG_VERSION");
    if managed_needs_update(&managed, version) {
        let _ = copy_managed_binaries(&bundled, &managed, version);
    }
    #[cfg(unix)]
    if let Some(user_bin) = user_bin_dir() {
        let link_path = user_bin.join(cli_binary_name());
        if let Ok(meta) = fs::symlink_metadata(&link_path)
            && meta.file_type().is_symlink()
            && !link_path.exists()
        {
            let exe = env::current_exe().ok();
            let ephemeral = exe
                .as_deref()
                .is_some_and(|path| is_ephemeral_exe(path, env::var_os("APPIMAGE").as_deref()));
            let target = if ephemeral {
                copy_managed_binaries(&bundled, &managed, version).ok()
            } else {
                Some(fs::canonicalize(&bundled).unwrap_or(bundled))
            };
            if let Some(target) = target {
                let _ = install_unix_symlink(&target, &link_path);
            }
        }
    }
}

pub fn mcp_config() -> Result<Value> {
    let mut status = cli_status();
    if status.installed && status.needs_update {
        sync_installed_cli();
        status = cli_status();
    }
    let command = if status.installed
        && let Some(path) = status.path
    {
        path
    } else if status.ephemeral {
        let installed = install_cli()?;
        installed.path.ok_or_else(|| {
            CoreError::config("Could not install the Strata CLI from the AppImage")
        })?
    } else if let Some(path) = status.path {
        path
    } else {
        return Err(CoreError::config(
            "The Strata CLI executable is unavailable",
        ));
    };
    Ok(json!({
        "mcpServers": {
            "strata": {
                "command": command,
                "args": ["mcp"]
            }
        }
    }))
}

fn io_error(error: impl std::fmt::Display) -> CoreError {
    CoreError::Io {
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsStr, fs, path::Path};

    use tempfile::tempdir;

    use super::{
        VERSION_STAMP, cli_binary_name, inspect_status, install_cli_with, is_ephemeral_exe,
        managed_needs_update, oracle_bridge_name,
    };

    #[test]
    fn detects_ephemeral_appimage_paths_and_env() {
        assert!(is_ephemeral_exe(
            Path::new("/tmp/.mount_StrataXYZ/usr/bin/strata-desktop"),
            None
        ));
        assert!(is_ephemeral_exe(
            Path::new("/usr/bin/strata-desktop"),
            Some(OsStr::new("/home/ada/Strata.AppImage"))
        ));
        assert!(!is_ephemeral_exe(
            Path::new("/usr/bin/strata-desktop"),
            None
        ));
    }

    #[cfg(unix)]
    #[test]
    fn installs_ephemeral_cli_by_copying_with_oracle_bridge_and_symlinking() {
        let root = tempdir().unwrap();
        let mount = root.path().join("mount");
        let user_bin = root.path().join("local-bin");
        let managed = root.path().join("managed-bin");
        fs::create_dir_all(&mount).unwrap();
        let bundled_cli = mount.join(cli_binary_name());
        let bundled_bridge = mount.join(oracle_bridge_name());
        fs::write(&bundled_cli, b"cli-v1").unwrap();
        fs::write(&bundled_bridge, b"bridge-v1").unwrap();

        let status = install_cli_with(
            &bundled_cli,
            true,
            &user_bin,
            &managed,
            Some(user_bin.as_os_str()),
            "0.7.0",
        )
        .expect("install ephemeral cli");

        assert!(status.installed);
        assert!(status.on_path);
        assert!(!status.needs_update);
        assert_eq!(
            status.path.as_deref(),
            Some(user_bin.join("strata").to_string_lossy().as_ref())
        );
        assert_eq!(fs::read(managed.join("strata")).unwrap(), b"cli-v1");
        assert_eq!(
            fs::read(managed.join("oracle-bridge")).unwrap(),
            b"bridge-v1"
        );
        assert_eq!(
            fs::read_link(user_bin.join("strata")).unwrap(),
            managed.join("strata")
        );
        assert!(!managed_needs_update(&managed, "0.7.0"));
        assert!(managed_needs_update(&managed, "0.8.0"));
    }

    #[cfg(unix)]
    #[test]
    fn installs_non_ephemeral_cli_as_symlink_and_refuses_to_overwrite_regular_file() {
        let root = tempdir().unwrap();
        let bundle = root.path().join("bundle");
        let user_bin = root.path().join("local-bin");
        let managed = root.path().join("managed-bin");
        fs::create_dir_all(&bundle).unwrap();
        fs::create_dir_all(&user_bin).unwrap();
        let bundled_cli = bundle.join(cli_binary_name());
        fs::write(&bundled_cli, b"cli-bundle").unwrap();

        let unrelated = user_bin.join(cli_binary_name());
        fs::write(&unrelated, b"other-tool").unwrap();
        let err = install_cli_with(&bundled_cli, false, &user_bin, &managed, None, "0.7.0")
            .expect_err("must not overwrite regular file");
        assert!(err.to_string().contains("Refusing to overwrite"));

        fs::remove_file(&unrelated).unwrap();
        let status = install_cli_with(&bundled_cli, false, &user_bin, &managed, None, "0.7.0")
            .expect("install symlink");
        assert!(status.installed);
        assert!(!status.on_path);
        assert_eq!(
            fs::read_link(user_bin.join("strata")).unwrap(),
            fs::canonicalize(&bundled_cli).unwrap()
        );
        assert!(!managed.join(VERSION_STAMP).exists());
    }

    #[test]
    fn recognizes_system_path_installation_without_extra_install() {
        let root = tempdir().unwrap();
        let sys_bin = root.path().join("usr-bin");
        fs::create_dir_all(&sys_bin).unwrap();
        let bundled_cli = sys_bin.join(cli_binary_name());
        fs::write(&bundled_cli, b"sys-cli").unwrap();

        let status = inspect_status(
            Some(&bundled_cli),
            false,
            Some(&root.path().join("local-bin")),
            Some(&root.path().join("managed")),
            Some(sys_bin.as_os_str()),
            "0.7.0",
        );
        assert!(status.installed);
        assert!(status.on_path);
        assert!(!status.needs_update);
        assert_eq!(
            status.path.as_deref(),
            Some(bundled_cli.to_string_lossy().as_ref())
        );
    }
}
