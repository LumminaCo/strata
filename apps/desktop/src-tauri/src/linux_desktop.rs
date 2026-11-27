use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

const APP_ID: &str = "strata";
const LEGACY_APP_ID: &str = "strata-desktop";
const APP_NAME: &str = "Strata";
const APP_COMMENT: &str = "Desktop database client";
const MANAGED_MARKER: &str = "X-Strata-Managed=true";
const DESKTOP_EXEC_RESERVED: &str = " \t\n\"'\\><~|&;$*?()#`";
const ICON_SIZES: [&str; 5] = ["32x32", "128x128", "256x256", "256x256@2", "512x512"];
const STALE_ICON_SIZES: [&str; 4] = ["16x16", "24x24", "48x48", "64x64"];
const PRIMARY_ICON_SIZE: &str = "256x256";

pub fn configure_identity() {
    // Keep a stable Linux app_id / WM_CLASS ("strata") and display name
    // ("Strata") regardless of the desktop binary name ("strata-desktop") so
    // Wayland and X11 compositors consistently match Strata's desktop entry.
    gtk::glib::set_prgname(Some(APP_ID));
    gtk::glib::set_application_name(APP_NAME);
}

pub fn sync_appimage_integration() {
    if env::var_os("STRATA_HOME").is_some_and(|value| !value.is_empty())
        || env::var_os("STRATA_BENCHMARK").is_some_and(|value| !value.is_empty())
    {
        return;
    }
    let Some(base_dirs) = directories::BaseDirs::new() else {
        return;
    };
    let data_home = base_dirs.data_local_dir().to_path_buf();
    let home_dir = base_dirs.home_dir().to_path_buf();

    let Some(appimage) = env::var_os("APPIMAGE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_file() && !path.starts_with("/tmp"))
    else {
        // Non-AppImage installs (e.g. .deb) install system icons under
        // /usr/share/icons/hicolor. If stale user-level overrides from an older
        // install exist under ~/.local/share/icons or ~/.icons, refresh them so
        // they cannot shadow the updated system icon.
        let system_hicolor = Path::new("/usr/share/icons/hicolor");
        if system_hicolor.is_dir()
            && refresh_existing_user_icon_overrides(system_hicolor, &data_home, Some(&home_dir))
        {
            spawn_cache_refresh(data_home, true, false);
        }
        return;
    };
    let Some(appdir) = resolve_appdir(
        env::var_os("APPDIR").as_deref().map(Path::new),
        env::current_exe().ok().as_deref(),
    ) else {
        return;
    };
    let system_desktop_exists = Path::new("/usr/share/applications/Strata.desktop").is_file()
        || Path::new("/usr/share/applications/strata.desktop").is_file();

    let result = sync_appimage_with(
        &appimage,
        &appdir,
        &data_home,
        Some(&home_dir),
        system_desktop_exists,
    );

    if result.icons_changed || result.desktop_changed {
        spawn_cache_refresh(data_home, result.icons_changed, result.desktop_changed);
    }
}

fn spawn_cache_refresh(data_home: PathBuf, icons_changed: bool, desktop_changed: bool) {
    std::thread::spawn(move || {
        if icons_changed {
            let _ = Command::new("gtk-update-icon-cache")
                .args(["-q", "-t", "-f"])
                .arg(data_home.join("icons/hicolor"))
                .status();
        }
        if desktop_changed {
            let _ = Command::new("update-desktop-database")
                .arg("-q")
                .arg(data_home.join("applications"))
                .status();
        }
    });
}

#[derive(Debug, Default, PartialEq, Eq)]
struct SyncResult {
    icons_changed: bool,
    desktop_changed: bool,
}

fn resolve_appdir(appdir_env: Option<&Path>, current_exe: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = appdir_env.filter(|path| !path.as_os_str().is_empty() && path.is_dir()) {
        return Some(dir.to_path_buf());
    }
    let exe = current_exe?;
    let dir = exe.parent()?.parent()?.parent()?;
    dir.is_dir().then(|| dir.to_path_buf())
}

fn write_if_changed(target: &Path, bytes: &[u8]) -> bool {
    if let Ok(existing) = fs::read(target)
        && existing == bytes
    {
        return false;
    }
    let Some(parent) = target.parent() else {
        return false;
    };
    if fs::create_dir_all(parent).is_err() {
        return false;
    }
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("strata");
    let temp = parent.join(format!(".{file_name}.tmp.{}", std::process::id()));
    if fs::write(&temp, bytes).is_err() {
        let _ = fs::remove_file(&temp);
        return false;
    }
    if fs::rename(&temp, target).is_err() {
        let _ = fs::remove_file(&temp);
        return false;
    }
    true
}

fn remove_if_exists(path: &Path) -> bool {
    path.is_file() && fs::remove_file(path).is_ok()
}

fn read_source_icon(source_hicolor: &Path, size: &str) -> Option<Vec<u8>> {
    let direct = source_hicolor.join(size).join("apps/strata.png");
    if let Ok(bytes) = fs::read(&direct) {
        return Some(bytes);
    }
    if size == "256x256@2" {
        return fs::read(source_hicolor.join("512x512/apps/strata.png")).ok();
    }
    None
}

fn cleanup_stale_user_icons(
    data_home: &Path,
    home_dir: Option<&Path>,
    primary_icon: Option<&[u8]>,
) -> bool {
    let mut changed = false;
    let target_hicolor = data_home.join("icons/hicolor");

    // Remove legacy scalable SVGs or smaller fixed sizes that could shadow the
    // updated hicolor PNGs.
    for name in ["strata.svg", "strata-desktop.svg"] {
        if remove_if_exists(&target_hicolor.join("scalable/apps").join(name)) {
            changed = true;
        }
        if remove_if_exists(&data_home.join("icons").join(name)) {
            changed = true;
        }
        if let Some(home) = home_dir
            && remove_if_exists(&home.join(".icons").join(name))
        {
            changed = true;
        }
    }

    for size in STALE_ICON_SIZES {
        for name in ["strata.png", "strata-desktop.png"] {
            if remove_if_exists(&target_hicolor.join(size).join("apps").join(name)) {
                changed = true;
            }
        }
    }

    // Refresh any unthemed fallback PNGs under ~/.local/share/icons or ~/.icons.
    if let Some(bytes) = primary_icon {
        for name in ["strata.png", "strata-desktop.png"] {
            let local_icon = data_home.join("icons").join(name);
            if local_icon.is_file() && write_if_changed(&local_icon, bytes) {
                changed = true;
            }
            if let Some(home) = home_dir {
                let legacy_icon = home.join(".icons").join(name);
                if legacy_icon.is_file() && write_if_changed(&legacy_icon, bytes) {
                    changed = true;
                }
            }
        }
    }

    changed
}

fn sync_user_icons(
    appdir: &Path,
    data_home: &Path,
    home_dir: Option<&Path>,
) -> (bool, Option<Vec<u8>>) {
    let source_hicolor = appdir.join("usr/share/icons/hicolor");
    let target_hicolor = data_home.join("icons/hicolor");
    let mut changed = false;
    let mut primary_icon = None;

    for size in ICON_SIZES {
        let Some(bytes) = read_source_icon(&source_hicolor, size) else {
            continue;
        };
        let target = target_hicolor.join(size).join("apps/strata.png");
        if write_if_changed(&target, &bytes) {
            changed = true;
        }
        let legacy_target = target_hicolor.join(size).join("apps/strata-desktop.png");
        if legacy_target.is_file() && write_if_changed(&legacy_target, &bytes) {
            changed = true;
        }
        if size == PRIMARY_ICON_SIZE {
            primary_icon = Some(bytes);
        }
    }

    if cleanup_stale_user_icons(data_home, home_dir, primary_icon.as_deref()) {
        changed = true;
    }

    (changed, primary_icon)
}

fn refresh_existing_user_icon_overrides(
    source_hicolor: &Path,
    data_home: &Path,
    home_dir: Option<&Path>,
) -> bool {
    let target_hicolor = data_home.join("icons/hicolor");
    let mut changed = false;
    let primary_icon = read_source_icon(source_hicolor, PRIMARY_ICON_SIZE);

    for size in ICON_SIZES {
        let Some(bytes) = read_source_icon(source_hicolor, size) else {
            continue;
        };
        for name in ["strata.png", "strata-desktop.png"] {
            let target = target_hicolor.join(size).join("apps").join(name);
            if target.is_file() && write_if_changed(&target, &bytes) {
                changed = true;
            }
        }
    }

    if cleanup_stale_user_icons(data_home, home_dir, primary_icon.as_deref()) {
        changed = true;
    }

    changed
}

fn escape_desktop_exec(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let needs_quotes = raw.chars().any(|ch| DESKTOP_EXEC_RESERVED.contains(ch));
    let mut escaped = String::with_capacity(raw.len() + 2);
    if needs_quotes {
        escaped.push('"');
    }
    for ch in raw.chars() {
        match ch {
            '%' => escaped.push_str("%%"),
            '"' | '`' | '$' | '\\' if needs_quotes => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }
    if needs_quotes {
        escaped.push('"');
    }
    escaped
}

fn build_managed_desktop_entry(appimage: &Path) -> String {
    let exec = escape_desktop_exec(appimage);
    [
        "[Desktop Entry]".to_owned(),
        "Categories=Development;".to_owned(),
        format!("Comment={APP_COMMENT}"),
        format!("Exec={exec}"),
        format!("Icon={APP_ID}"),
        format!("Name={APP_NAME}"),
        format!("StartupWMClass={APP_ID}"),
        "Terminal=false".to_owned(),
        "Type=Application".to_owned(),
        MANAGED_MARKER.to_owned(),
        String::new(),
    ]
    .join("\n")
}

fn exec_contains_path(exec_value: &str, candidate: &str) -> bool {
    if candidate.is_empty() {
        return false;
    }
    let normalized = exec_value.replace("%%", "%");
    let mut search_from = 0;
    while let Some(offset) = normalized[search_from..].find(candidate) {
        let start = search_from + offset;
        let end = start + candidate.len();
        let valid_before = start == 0
            || normalized[..start]
                .chars()
                .next_back()
                .is_some_and(|ch| ch.is_whitespace() || matches!(ch, '"' | '\'' | '='));
        let valid_after = end == normalized.len()
            || normalized[end..]
                .chars()
                .next()
                .is_some_and(|ch| ch.is_whitespace() || matches!(ch, '"' | '\''));
        if valid_before && valid_after {
            return true;
        }
        search_from = end;
    }
    false
}

fn desktop_entry_matches_appimage(
    content: &str,
    appimage: &Path,
    canonical_appimage: Option<&Path>,
) -> bool {
    let mut in_desktop_entry = false;
    let appimage_str = appimage.to_string_lossy();
    let canonical_str = canonical_appimage.map(|path| path.to_string_lossy());
    let mut claims_strata_wm_class = false;
    let mut exec_looks_like_appimage = false;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_desktop_entry = trimmed == "[Desktop Entry]";
            continue;
        }
        if !in_desktop_entry || trimmed.starts_with('#') {
            continue;
        }
        if trimmed == MANAGED_MARKER {
            return true;
        }
        if let Some(wm_class) = trimmed.strip_prefix("StartupWMClass=") {
            let wm_class = wm_class.trim();
            if wm_class.eq_ignore_ascii_case(APP_ID) || wm_class.eq_ignore_ascii_case(LEGACY_APP_ID)
            {
                claims_strata_wm_class = true;
            }
        }
        if let Some(exec_value) = trimmed.strip_prefix("Exec=") {
            let exec_value = exec_value.trim();
            if exec_contains_path(exec_value, &appimage_str) {
                return true;
            }
            if let Some(canonical) = canonical_str.as_deref()
                && exec_contains_path(exec_value, canonical)
            {
                return true;
            }
            let lower = exec_value.to_ascii_lowercase();
            if lower.contains(".appimage") && lower.contains("strata") {
                exec_looks_like_appimage = true;
            }
        }
    }
    claims_strata_wm_class && exec_looks_like_appimage
}

fn is_refreshable_cached_icon(path: &Path, home_dir: Option<&Path>) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let Some(home) = home_dir else {
        return false;
    };
    if !path.starts_with(home) {
        return false;
    }
    let allowed_ext = match path.extension().and_then(|ext| ext.to_str()) {
        None => true,
        Some(ext) => matches!(
            ext.to_ascii_lowercase().as_str(),
            "png" | "svg" | "ico" | "webp" | "jpg" | "jpeg" | "xpm"
        ),
    };
    if !allowed_ext {
        return false;
    }
    let path_lower = path.to_string_lossy().to_ascii_lowercase();
    let has_strata_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.to_ascii_lowercase().contains("strata"));
    let in_icons_dir = path
        .parent()
        .and_then(|dir| dir.file_name())
        .and_then(|name| name.to_str())
        .is_some_and(|name| matches!(name, ".icons" | "icons"));
    let is_manager_cache = path_lower.contains("gearlever") || path_lower.contains("appimage");
    has_strata_name || in_icons_dir || is_manager_cache
}

fn is_png_writable_path(path: &Path) -> bool {
    match path.extension().and_then(|ext| ext.to_str()) {
        None => true,
        Some(ext) => ext.eq_ignore_ascii_case("png"),
    }
}

fn update_desktop_entry(
    content: &str,
    appimage: &Path,
    home_dir: Option<&Path>,
    primary_icon: Option<&[u8]>,
) -> (String, bool, bool) {
    let mut out = Vec::new();
    let mut in_desktop_entry = false;
    let mut seen_desktop_entry = false;
    let mut has_name = false;
    let mut has_wm_class = false;
    let mut has_icon = false;
    let mut is_managed = false;
    let mut desktop_changed = false;
    let mut icon_file_changed = false;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if in_desktop_entry {
                if !has_name {
                    out.push(format!("Name={APP_NAME}"));
                    desktop_changed = true;
                }
                if !has_icon {
                    out.push(format!("Icon={APP_ID}"));
                    desktop_changed = true;
                }
                if !has_wm_class {
                    out.push(format!("StartupWMClass={APP_ID}"));
                    desktop_changed = true;
                }
            }
            in_desktop_entry = trimmed == "[Desktop Entry]";
            if in_desktop_entry {
                seen_desktop_entry = true;
            }
            out.push(line.to_owned());
            continue;
        }

        if !in_desktop_entry {
            out.push(line.to_owned());
            continue;
        }

        if trimmed == MANAGED_MARKER {
            is_managed = true;
            out.push(line.to_owned());
            continue;
        }

        if let Some(value) = trimmed.strip_prefix("Name=") {
            has_name = true;
            let value = value.trim();
            if value.is_empty() || value.eq_ignore_ascii_case(LEGACY_APP_ID) {
                out.push(format!("Name={APP_NAME}"));
                desktop_changed = true;
            } else {
                out.push(line.to_owned());
            }
            continue;
        }

        if let Some(value) = trimmed.strip_prefix("StartupWMClass=") {
            has_wm_class = true;
            if value.trim() != APP_ID {
                out.push(format!("StartupWMClass={APP_ID}"));
                desktop_changed = true;
            } else {
                out.push(line.to_owned());
            }
            continue;
        }

        if let Some(value) = trimmed.strip_prefix("Icon=") {
            has_icon = true;
            let icon_value = value.trim();
            let icon_path = Path::new(icon_value);
            if icon_value.is_empty()
                || icon_value == LEGACY_APP_ID
                || icon_value.starts_with("appimagekit_")
                || icon_value.starts_with("gearlever_")
            {
                out.push(format!("Icon={APP_ID}"));
                desktop_changed = true;
            } else if icon_path.is_absolute() {
                if !icon_path.is_file() {
                    out.push(format!("Icon={APP_ID}"));
                    desktop_changed = true;
                } else if is_refreshable_cached_icon(icon_path, home_dir) {
                    if let Some(bytes) = primary_icon
                        && is_png_writable_path(icon_path)
                        && write_if_changed(icon_path, bytes)
                    {
                        icon_file_changed = true;
                    }
                    // Point the desktop entry at the hicolor theme icon name so
                    // GNOME Shell / KDE immediately reload the updated icon
                    // instead of holding onto a cached absolute path texture.
                    out.push(format!("Icon={APP_ID}"));
                    desktop_changed = true;
                } else {
                    out.push(line.to_owned());
                }
            } else {
                out.push(line.to_owned());
            }
            continue;
        }

        out.push(line.to_owned());
    }

    if in_desktop_entry {
        if !has_name {
            out.push(format!("Name={APP_NAME}"));
            desktop_changed = true;
        }
        if !has_icon {
            out.push(format!("Icon={APP_ID}"));
            desktop_changed = true;
        }
        if !has_wm_class {
            out.push(format!("StartupWMClass={APP_ID}"));
            desktop_changed = true;
        }
    }

    if is_managed && seen_desktop_entry {
        let expected_exec = format!("Exec={}", escape_desktop_exec(appimage));
        let mut inside = false;
        for line in &mut out {
            let trimmed = line.trim();
            if trimmed.starts_with('[') && trimmed.ends_with(']') {
                inside = trimmed == "[Desktop Entry]";
                continue;
            }
            if inside && trimmed.starts_with("Exec=") {
                if trimmed != expected_exec {
                    *line = expected_exec.clone();
                    desktop_changed = true;
                }
                break;
            }
        }
    }

    let mut rendered = out.join("\n");
    rendered.push('\n');
    (rendered, desktop_changed, icon_file_changed)
}

fn sync_appimage_with(
    appimage: &Path,
    appdir: &Path,
    data_home: &Path,
    home_dir: Option<&Path>,
    system_desktop_exists: bool,
) -> SyncResult {
    let (mut icons_changed, primary_icon) = sync_user_icons(appdir, data_home, home_dir);
    let mut desktop_changed = false;

    let applications = data_home.join("applications");
    let canonical_appimage = fs::canonicalize(appimage).ok();
    let mut matched_existing = false;

    if let Ok(entries) = fs::read_dir(&applications) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("desktop") || !path.is_file() {
                continue;
            }
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            if !desktop_entry_matches_appimage(&content, appimage, canonical_appimage.as_deref()) {
                continue;
            }
            matched_existing = true;
            let (updated, changed, icon_updated) =
                update_desktop_entry(&content, appimage, home_dir, primary_icon.as_deref());
            if icon_updated {
                icons_changed = true;
            }
            if changed && write_if_changed(&path, updated.as_bytes()) {
                desktop_changed = true;
            }
        }
    }

    if !matched_existing && !system_desktop_exists {
        let managed = applications.join("strata.desktop");
        if !managed.exists() {
            let entry = build_managed_desktop_entry(appimage);
            if write_if_changed(&managed, entry.as_bytes()) {
                desktop_changed = true;
            }
        }
    }

    SyncResult {
        icons_changed,
        desktop_changed,
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use tempfile::tempdir;

    use super::{
        APP_ID, APP_NAME, MANAGED_MARKER, desktop_entry_matches_appimage, escape_desktop_exec,
        refresh_existing_user_icon_overrides, resolve_appdir, sync_appimage_with,
        update_desktop_entry,
    };

    fn seed_appdir_icons(appdir: &Path, payload: &[u8]) {
        for size in ["32x32", "128x128", "256x256", "256x256@2", "512x512"] {
            let dir = appdir
                .join("usr/share/icons/hicolor")
                .join(size)
                .join("apps");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("strata.png"), payload).unwrap();
        }
    }

    #[test]
    fn resolves_appdir_from_env_or_exe_path() {
        let root = tempdir().unwrap();
        let appdir = root.path().join("mount");
        let exe = appdir.join("usr/bin/strata-desktop");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, b"").unwrap();

        assert_eq!(resolve_appdir(Some(&appdir), None), Some(appdir.clone()));
        assert_eq!(resolve_appdir(None, Some(&exe)), Some(appdir));
    }

    #[test]
    fn escapes_desktop_exec_paths() {
        assert_eq!(
            escape_desktop_exec(Path::new("/home/ada/Applications/Strata.AppImage")),
            "/home/ada/Applications/Strata.AppImage"
        );
        assert_eq!(
            escape_desktop_exec(Path::new("/home/ada/My Apps/Strata 100%.AppImage")),
            "\"/home/ada/My Apps/Strata 100%%.AppImage\""
        );
    }

    #[test]
    fn matches_existing_desktop_entries_for_appimage() {
        let appimage = Path::new("/home/ada/Applications/Strata.AppImage");
        let gear_lever = "\
[Desktop Entry]
Name=Strata
Exec=/home/ada/Applications/Strata.AppImage %U
Icon=/home/ada/Applications/.icons/strata.png
StartupWMClass=strata-desktop
";
        assert!(desktop_entry_matches_appimage(gear_lever, appimage, None));

        let renamed_appimage = "\
[Desktop Entry]
Name=Strata
Exec=/home/ada/Applications/Strata_0.7.0_amd64.AppImage
Icon=/home/ada/Applications/.icons/strata
StartupWMClass=strata
";
        assert!(desktop_entry_matches_appimage(
            renamed_appimage,
            appimage,
            None
        ));

        let other = "\
[Desktop Entry]
Name=Other
Exec=/home/ada/Applications/Strata.AppImage.bak
";
        assert!(!desktop_entry_matches_appimage(other, appimage, None));
    }

    #[test]
    fn repairs_legacy_wm_class_name_and_icons_on_existing_desktop_entry() {
        let root = tempdir().unwrap();
        let home = root.path();
        let appimage = home.join("Applications/Strata.AppImage");
        let cached_icon = home.join("Applications/.icons/strata_cached");
        fs::create_dir_all(cached_icon.parent().unwrap()).unwrap();
        fs::write(&cached_icon, b"old-icon").unwrap();

        let original = format!(
            "[Desktop Entry]\n\
             Name=strata-desktop\n\
             Exec={}\n\
             Icon={}\n\
             StartupWMClass=strata-desktop\n\
             X-AppImage-Version=0.8.0\n",
            appimage.display(),
            cached_icon.display()
        );
        let (updated, desktop_changed, icon_changed) =
            update_desktop_entry(&original, &appimage, Some(home), Some(b"new-icon"));

        assert!(desktop_changed);
        assert!(icon_changed);
        assert!(updated.contains(&format!("Name={APP_NAME}\n")));
        assert!(updated.contains(&format!("Icon={APP_ID}\n")));
        assert!(updated.contains(&format!("StartupWMClass={APP_ID}\n")));
        assert!(updated.contains("X-AppImage-Version=0.8.0"));
        assert_eq!(fs::read(&cached_icon).unwrap(), b"new-icon");

        let (second, desktop_changed_again, icon_changed_again) =
            update_desktop_entry(&updated, &appimage, Some(home), Some(b"new-icon"));
        assert_eq!(second, updated);
        assert!(!desktop_changed_again);
        assert!(!icon_changed_again);
    }

    #[test]
    fn replaces_legacy_theme_and_appimage_manager_icons_with_strata() {
        let appimage = Path::new("/home/ada/Applications/Strata.AppImage");
        for icon in [
            "appimagekit_123456_strata-desktop",
            "gearlever_strata_abc123",
            "strata-desktop",
        ] {
            let entry = format!(
                "[Desktop Entry]\n\
                 Name=Strata\n\
                 Exec=/home/ada/Applications/Strata.AppImage\n\
                 Icon={icon}\n"
            );
            let (updated, desktop_changed, _) = update_desktop_entry(&entry, appimage, None, None);
            assert!(desktop_changed);
            assert!(updated.contains("Icon=strata\n"));
            assert!(updated.contains("StartupWMClass=strata\n"));
        }
    }

    #[test]
    fn syncs_icons_cleans_stale_overrides_and_creates_managed_desktop_entry() {
        let root = tempdir().unwrap();
        let appdir = root.path().join("appdir");
        let data_home = root.path().join("data");
        let appimage = root.path().join("Applications/Strata.AppImage");
        fs::create_dir_all(appimage.parent().unwrap()).unwrap();
        fs::write(&appimage, b"appimage").unwrap();
        seed_appdir_icons(&appdir, b"v0.8.2-icon");

        let stale_svg = data_home.join("icons/hicolor/scalable/apps/strata.svg");
        let stale_48 = data_home.join("icons/hicolor/48x48/apps/strata.png");
        fs::create_dir_all(stale_svg.parent().unwrap()).unwrap();
        fs::create_dir_all(stale_48.parent().unwrap()).unwrap();
        fs::write(&stale_svg, b"<svg/>").unwrap();
        fs::write(&stale_48, b"old-48").unwrap();

        let first = sync_appimage_with(&appimage, &appdir, &data_home, Some(root.path()), false);
        assert!(first.icons_changed);
        assert!(first.desktop_changed);
        assert!(!stale_svg.exists());
        assert!(!stale_48.exists());

        let desktop_path = data_home.join("applications/strata.desktop");
        let content = fs::read_to_string(&desktop_path).unwrap();
        assert!(content.contains("Name=Strata\n"));
        assert!(content.contains("Icon=strata\n"));
        assert!(content.contains("StartupWMClass=strata\n"));
        assert!(content.contains(MANAGED_MARKER));
        assert_eq!(
            fs::read(data_home.join("icons/hicolor/256x256/apps/strata.png")).unwrap(),
            b"v0.8.2-icon"
        );
        assert_eq!(
            fs::read(data_home.join("icons/hicolor/256x256@2/apps/strata.png")).unwrap(),
            b"v0.8.2-icon"
        );

        let second = sync_appimage_with(&appimage, &appdir, &data_home, Some(root.path()), false);
        assert!(!second.icons_changed);
        assert!(!second.desktop_changed);

        // Moving the AppImage updates the managed desktop entry's Exec path.
        let moved = root.path().join("Applications/Strata-moved.AppImage");
        fs::write(&moved, b"appimage").unwrap();
        let third = sync_appimage_with(&moved, &appdir, &data_home, Some(root.path()), false);
        assert!(!third.icons_changed);
        assert!(third.desktop_changed);
        let moved_content = fs::read_to_string(&desktop_path).unwrap();
        assert!(moved_content.contains(&format!("Exec={}\n", moved.display())));
    }

    #[test]
    fn refreshes_existing_user_icon_overrides_for_system_installs() {
        let root = tempdir().unwrap();
        let system_hicolor = root.path().join("usr/share/icons/hicolor");
        let data_home = root.path().join("data");
        for size in ["32x32", "128x128", "256x256", "256x256@2", "512x512"] {
            let dir = system_hicolor.join(size).join("apps");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("strata.png"), b"new-system-icon").unwrap();
        }

        let user_override = data_home.join("icons/hicolor/256x256@2/apps/strata.png");
        fs::create_dir_all(user_override.parent().unwrap()).unwrap();
        fs::write(&user_override, b"old-user-icon").unwrap();

        assert!(refresh_existing_user_icon_overrides(
            &system_hicolor,
            &data_home,
            Some(root.path()),
        ));
        assert_eq!(fs::read(&user_override).unwrap(), b"new-system-icon");
        assert!(
            !data_home
                .join("icons/hicolor/32x32/apps/strata.png")
                .exists()
        );
        assert!(!refresh_existing_user_icon_overrides(
            &system_hicolor,
            &data_home,
            Some(root.path()),
        ));
    }

    #[test]
    fn skips_creating_user_desktop_entry_when_system_entry_exists() {
        let root = tempdir().unwrap();
        let appdir = root.path().join("appdir");
        let data_home = root.path().join("data");
        let appimage = root.path().join("Applications/Strata.AppImage");
        fs::create_dir_all(appimage.parent().unwrap()).unwrap();
        fs::write(&appimage, b"appimage").unwrap();
        seed_appdir_icons(&appdir, b"icon");

        let result = sync_appimage_with(&appimage, &appdir, &data_home, Some(root.path()), true);
        assert!(result.icons_changed);
        assert!(!result.desktop_changed);
        assert!(!data_home.join("applications/strata.desktop").exists());
    }
}
