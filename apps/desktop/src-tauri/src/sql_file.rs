use std::{
    fs,
    path::{Path, PathBuf},
};

use directories::UserDirs;
use serde_json::{Value, json};
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::updater::AppActivity;

pub const DEFAULT_SQL_FILE_NAME: &str = "query.sql";
pub const MAX_SQL_FILE_BYTES: u64 = 8_000_000;
const DEFAULT_QUERIES_FOLDER: &str = "Strata";

#[derive(Debug, PartialEq, Eq)]
pub struct OpenedSqlFile {
    pub path: String,
    pub content: String,
}

fn resolve_default_queries_dir(
    document_dir: Option<&Path>,
    home_dir: Option<&Path>,
) -> Option<PathBuf> {
    let documents = document_dir
        .filter(|dir| !dir.as_os_str().is_empty() && home_dir != Some(*dir))
        .map(Path::to_path_buf)
        .or_else(|| {
            home_dir
                .filter(|home| !home.as_os_str().is_empty())
                .map(|home| home.join("Documents"))
        })?;
    Some(documents.join(DEFAULT_QUERIES_FOLDER))
}

fn default_queries_dir() -> Option<PathBuf> {
    let user_dirs = UserDirs::new()?;
    resolve_default_queries_dir(user_dirs.document_dir(), Some(user_dirs.home_dir()))
}

fn ensure_default_queries_dir(dir: &Path) -> Option<PathBuf> {
    if fs::create_dir_all(dir).is_ok() {
        return Some(dir.to_path_buf());
    }
    dir.parent()
        .filter(|parent| !parent.as_os_str().is_empty() && parent.is_dir())
        .map(Path::to_path_buf)
}

fn extract_file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty() && !matches!(*name, "." | ".."))
        .map(str::to_owned)
        .unwrap_or_else(|| DEFAULT_SQL_FILE_NAME.into())
}

fn prepare_save_target(
    suggested_path: Option<&str>,
    default_dir: Option<&Path>,
) -> (Option<PathBuf>, String) {
    let suggested = suggested_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(Path::new);

    if let Some(path) = suggested {
        let file_name = extract_file_name(path);
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty() && parent.is_dir())
        {
            return (Some(parent.to_path_buf()), file_name);
        }
        let directory = default_dir.and_then(ensure_default_queries_dir);
        return (directory, file_name);
    }

    let directory = default_dir.and_then(ensure_default_queries_dir);
    (directory, DEFAULT_SQL_FILE_NAME.into())
}

fn direct_save_path(suggested_path: Option<&str>, save_as: bool) -> Option<PathBuf> {
    if save_as {
        return None;
    }
    let path = suggested_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(Path::new)?;
    if !path.is_absolute() || path.is_dir() {
        return None;
    }
    let has_valid_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .is_some_and(|name| !name.is_empty() && !matches!(name, "." | ".."));
    if !has_valid_name {
        return None;
    }
    if !path
        .parent()
        .is_some_and(|parent| !parent.as_os_str().is_empty() && parent.is_dir())
    {
        return None;
    }
    Some(path.to_path_buf())
}

fn prepare_open_directory(
    suggested_path: Option<&str>,
    default_dir: Option<&Path>,
) -> Option<PathBuf> {
    let suggested = suggested_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(Path::new);
    if let Some(parent) = suggested
        .and_then(Path::parent)
        .filter(|parent| !parent.as_os_str().is_empty() && parent.is_dir())
    {
        return Some(parent.to_path_buf());
    }
    default_dir
        .filter(|dir| dir.is_dir())
        .map(Path::to_path_buf)
}

fn write_sql_file(path: &Path, content: &str) -> Result<String, String> {
    fs::write(path, content.as_bytes())
        .map_err(|error| format!("Could not save SQL file: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

fn read_sql_file(path: &Path) -> Result<OpenedSqlFile, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("Could not open SQL file: {error}"))?;
    if metadata.len() > MAX_SQL_FILE_BYTES {
        return Err("The SQL file exceeds 8 MB.".into());
    }
    let content =
        fs::read_to_string(path).map_err(|error| format!("Could not read SQL file: {error}"))?;
    Ok(OpenedSqlFile {
        path: path.to_string_lossy().into_owned(),
        content,
    })
}

enum SaveTarget {
    Direct(PathBuf),
    Prompt(Option<PathBuf>, String),
}

#[tauri::command]
pub async fn save_sql_file(
    handle: AppHandle,
    window: WebviewWindow,
    activity: State<'_, AppActivity>,
    content: String,
    suggested_path: Option<String>,
    save_as: Option<bool>,
) -> Result<Option<String>, String> {
    let _operation = activity.begin_operation().map_err(|error| error.message)?;
    let save_as = save_as.unwrap_or(false);
    let target = tauri::async_runtime::spawn_blocking(move || {
        if let Some(path) = direct_save_path(suggested_path.as_deref(), save_as) {
            return SaveTarget::Direct(path);
        }
        let default_dir = default_queries_dir();
        let (directory, file_name) =
            prepare_save_target(suggested_path.as_deref(), default_dir.as_deref());
        SaveTarget::Prompt(directory, file_name)
    })
    .await
    .map_err(|error| error.to_string())?;

    let path = match target {
        SaveTarget::Direct(path) => path,
        SaveTarget::Prompt(directory, file_name) => {
            let mut dialog = handle
                .dialog()
                .file()
                .set_title(if save_as {
                    "Save SQL file as"
                } else {
                    "Save SQL file"
                })
                .set_file_name(&file_name)
                .add_filter("SQL files", &["sql"])
                .set_can_create_directories(true)
                .set_parent(&window);
            #[cfg(not(target_os = "macos"))]
            {
                dialog = dialog.add_filter("All files", &["*"]);
            }
            if let Some(directory) = directory {
                dialog = dialog.set_directory(directory);
            }

            let (sender, receiver) = tokio::sync::oneshot::channel();
            dialog.save_file(move |selection| {
                let _ = sender.send(selection);
            });

            let Some(selection) = receiver
                .await
                .map_err(|_| "Save dialog was closed unexpectedly.")?
            else {
                return Ok(None);
            };
            selection
                .into_path()
                .map_err(|error| format!("Could not resolve selected file path: {error}"))?
        }
    };

    let saved = tauri::async_runtime::spawn_blocking(move || write_sql_file(&path, &content))
        .await
        .map_err(|error| error.to_string())??;
    Ok(Some(saved))
}

#[tauri::command]
pub async fn open_sql_file(
    handle: AppHandle,
    window: WebviewWindow,
    activity: State<'_, AppActivity>,
    suggested_path: Option<String>,
) -> Result<Option<Value>, String> {
    let _operation = activity.begin_operation().map_err(|error| error.message)?;
    let directory = tauri::async_runtime::spawn_blocking(move || {
        let default_dir = default_queries_dir();
        prepare_open_directory(suggested_path.as_deref(), default_dir.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?;

    let mut dialog = handle
        .dialog()
        .file()
        .set_title("Open SQL file")
        .add_filter("SQL files", &["sql"])
        .set_parent(&window);
    #[cfg(not(target_os = "macos"))]
    {
        dialog = dialog.add_filter("All files", &["*"]);
    }
    if let Some(directory) = directory {
        dialog = dialog.set_directory(directory);
    }

    let (sender, receiver) = tokio::sync::oneshot::channel();
    dialog.pick_file(move |selection| {
        let _ = sender.send(selection);
    });

    let Some(selection) = receiver
        .await
        .map_err(|_| "Open dialog was closed unexpectedly.")?
    else {
        return Ok(None);
    };
    let path = selection
        .into_path()
        .map_err(|error| format!("Could not resolve selected file path: {error}"))?;

    let opened = tauri::async_runtime::spawn_blocking(move || read_sql_file(&path))
        .await
        .map_err(|error| error.to_string())??;
    Ok(Some(json!({
        "path": opened.path,
        "content": opened.content,
    })))
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use tempfile::tempdir;

    use super::{
        DEFAULT_SQL_FILE_NAME, MAX_SQL_FILE_BYTES, OpenedSqlFile, direct_save_path,
        prepare_open_directory, prepare_save_target, read_sql_file, resolve_default_queries_dir,
        write_sql_file,
    };

    #[test]
    fn resolves_platform_documents_strata_folder() {
        let home = Path::new("/home/ada");
        let documents = Path::new("/home/ada/Documents");
        assert_eq!(
            resolve_default_queries_dir(Some(documents), Some(home)),
            Some(documents.join("Strata"))
        );
    }

    #[test]
    fn falls_back_to_home_documents_when_document_dir_missing_or_equals_home() {
        let home = Path::new("/home/ada");
        assert_eq!(
            resolve_default_queries_dir(None, Some(home)),
            Some(home.join("Documents").join("Strata"))
        );
        assert_eq!(
            resolve_default_queries_dir(Some(home), Some(home)),
            Some(home.join("Documents").join("Strata"))
        );
        assert_eq!(resolve_default_queries_dir(None, None), None);
    }

    #[test]
    fn creates_and_suggests_default_strata_folder_when_no_prior_path() {
        let root = tempdir().unwrap();
        let default_dir = root.path().join("Documents").join("Strata");
        assert!(!default_dir.exists());

        let (directory, file_name) = prepare_save_target(None, Some(&default_dir));
        assert!(default_dir.is_dir());
        assert_eq!(directory, Some(default_dir));
        assert_eq!(file_name, DEFAULT_SQL_FILE_NAME);
    }

    #[test]
    fn reuses_existing_parent_directory_and_filename_from_suggested_path() {
        let root = tempdir().unwrap();
        let default_dir = root.path().join("Documents").join("Strata");
        let custom_dir = root.path().join("projects").join("analytics");
        fs::create_dir_all(&custom_dir).unwrap();
        let previous = custom_dir.join("monthly_sales.sql");

        let (directory, file_name) =
            prepare_save_target(Some(previous.to_str().unwrap()), Some(&default_dir));
        assert_eq!(directory, Some(custom_dir));
        assert_eq!(file_name, "monthly_sales.sql");
    }

    #[test]
    fn falls_back_to_default_folder_when_suggested_parent_is_missing() {
        let root = tempdir().unwrap();
        let default_dir = root.path().join("Documents").join("Strata");
        let missing = root.path().join("deleted").join("report.sql");

        let (directory, file_name) =
            prepare_save_target(Some(missing.to_str().unwrap()), Some(&default_dir));
        assert!(default_dir.is_dir());
        assert_eq!(directory, Some(default_dir));
        assert_eq!(file_name, "report.sql");
    }

    #[test]
    fn writes_and_overwrites_sql_content_at_selected_path() {
        let root = tempdir().unwrap();
        let target = root.path().join("saved_query.sql");
        let sql = "SELECT 1 AS ok;\n";

        let saved = write_sql_file(&target, sql).unwrap();
        assert_eq!(saved, target.to_string_lossy());
        assert_eq!(fs::read_to_string(&target).unwrap(), sql);

        let updated = "SELECT 2 AS updated;\n";
        let overwritten = write_sql_file(&target, updated).unwrap();
        assert_eq!(overwritten, target.to_string_lossy());
        assert_eq!(fs::read_to_string(&target).unwrap(), updated);
    }

    #[test]
    fn saves_directly_to_previous_absolute_path_unless_save_as_is_requested() {
        let root = tempdir().unwrap();
        let folder = root.path().join("queries");
        fs::create_dir_all(&folder).unwrap();
        let existing = folder.join("monthly_sales.sql");
        fs::write(&existing, "SELECT 1;").unwrap();

        assert_eq!(
            direct_save_path(existing.to_str(), false),
            Some(existing.clone())
        );
        assert_eq!(direct_save_path(existing.to_str(), true), None);
        assert_eq!(direct_save_path(None, false), None);
        assert_eq!(direct_save_path(Some("   "), false), None);
        assert_eq!(direct_save_path(Some("monthly_sales.sql"), false), None);
        assert_eq!(direct_save_path(folder.to_str(), false), None);

        let missing_parent = root.path().join("deleted").join("monthly_sales.sql");
        assert_eq!(direct_save_path(missing_parent.to_str(), false), None);
    }

    #[test]
    fn prepares_open_directory_without_creating_missing_folders() {
        let root = tempdir().unwrap();
        let default_dir = root.path().join("Documents").join("Strata");
        assert_eq!(prepare_open_directory(None, Some(&default_dir)), None);
        assert!(!default_dir.exists());

        fs::create_dir_all(&default_dir).unwrap();
        assert_eq!(
            prepare_open_directory(None, Some(&default_dir)),
            Some(default_dir.clone())
        );

        let custom_dir = root.path().join("analytics");
        fs::create_dir_all(&custom_dir).unwrap();
        let previous = custom_dir.join("cohort.sql");
        assert_eq!(
            prepare_open_directory(previous.to_str(), Some(&default_dir)),
            Some(custom_dir)
        );
    }

    #[test]
    fn reads_sql_files_and_rejects_oversized_files() {
        let root = tempdir().unwrap();
        let target = root.path().join("report.sql");
        let sql = "SELECT customer_id, SUM(total) FROM orders GROUP BY customer_id;\n";
        fs::write(&target, sql).unwrap();

        let opened = read_sql_file(&target).unwrap();
        assert_eq!(
            opened,
            OpenedSqlFile {
                path: target.to_string_lossy().into_owned(),
                content: sql.into(),
            }
        );

        let huge = root.path().join("huge.sql");
        let file = fs::File::create(&huge).unwrap();
        file.set_len(MAX_SQL_FILE_BYTES + 1).unwrap();
        let error = read_sql_file(&huge).unwrap_err();
        assert_eq!(error, "The SQL file exceeds 8 MB.");
    }
}
