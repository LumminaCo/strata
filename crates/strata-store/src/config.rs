use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use strata_core::{CoreError, Profile, Result};
use tokio::sync::watch;
use toml_edit::{ArrayOfTables, DocumentMut, Item, Table};

use crate::io_error;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    pub fetch_size: usize,
    pub row_cap: usize,
    pub theme: Theme,
    pub blank_line_delimiter: bool,
    pub editor_font_size: u16,
    pub statement_timeout_ms: u32,
    pub agent_default_row_limit: usize,
    pub agent_statement_timeout_s: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            fetch_size: 500,
            row_cap: 200_000,
            theme: Theme::System,
            blank_line_delimiter: true,
            editor_font_size: 13,
            statement_timeout_ms: 0,
            agent_default_row_limit: 200,
            agent_statement_timeout_s: 30,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default, rename = "connection")]
    pub connections: Vec<Profile>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: 1,
            settings: Settings::default(),
            connections: Vec::new(),
        }
    }
}

impl Config {
    fn parse(text: &str) -> Result<Self> {
        let config: Self = toml::from_str(text)
            .map_err(|_| CoreError::config("config.toml contains invalid TOML or settings"))?;
        if config.version != 1 {
            return Err(CoreError::config("Unsupported config.toml version"));
        }
        let settings = &config.settings;
        if settings.fetch_size == 0
            || settings.row_cap == 0
            || settings.row_cap > 200_000
            || settings.agent_default_row_limit == 0
            || settings.agent_statement_timeout_s == 0
        {
            return Err(CoreError::config("Invalid query limits"));
        }
        let mut ids = HashSet::new();
        let mut names = HashSet::new();
        for profile in &config.connections {
            profile.validate()?;
            if !ids.insert(profile.id) || !names.insert(profile.name.trim()) {
                return Err(CoreError::config("Connection IDs and names must be unique"));
            }
        }
        Ok(config)
    }
}

pub struct ConfigStore {
    path: PathBuf,
}

#[derive(Clone, Debug)]
pub struct ConfigUpdate {
    pub config: Config,
    pub error: Option<String>,
}

pub struct WatchedConfig {
    _watcher: RecommendedWatcher,
    updates: watch::Receiver<ConfigUpdate>,
}

impl WatchedConfig {
    pub fn updates(&self) -> watch::Receiver<ConfigUpdate> {
        self.updates.clone()
    }
}

impl ConfigStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn load(&self) -> Result<Config> {
        Config::parse(&self.read()?)
    }

    pub fn watch(&self) -> Result<WatchedConfig> {
        let path = std::path::absolute(&self.path).map_err(io_error)?;
        let parent = path
            .parent()
            .ok_or_else(|| CoreError::config("Config path has no parent"))?
            .to_owned();
        fs::create_dir_all(&parent).map_err(io_error)?;
        let parent = fs::canonicalize(parent).map_err(io_error)?;
        let filename = path
            .file_name()
            .ok_or_else(|| CoreError::config("Config path has no filename"))?;
        let store = Self::new(parent.join(filename));
        let (sender, updates) = watch::channel(ConfigUpdate {
            config: store.load()?,
            error: None,
        });
        let initial = sender.clone();
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
            let loaded = match event {
                Ok(event) if !event.kind.is_access() && event.paths.contains(&store.path) => {
                    store.load()
                }
                Ok(_) => return,
                Err(_) => Err(CoreError::config("Could not watch config.toml for changes")),
            };
            publish_config(&sender, loaded);
        })
        .map_err(io_error)?;
        watcher
            .watch(&parent, RecursiveMode::NonRecursive)
            .map_err(io_error)?;
        publish_config(&initial, self.load());
        Ok(WatchedConfig {
            _watcher: watcher,
            updates,
        })
    }

    pub fn save_profile(&self, profile: &Profile) -> Result<()> {
        profile.validate()?;
        let encoded = toml_edit::ser::to_document(profile)
            .map_err(|_| CoreError::config("Cannot encode connection"))?;
        self.edit(|document| {
            let entries = document
                .entry("connection")
                .or_insert(Item::ArrayOfTables(ArrayOfTables::new()));
            if entries.as_array().is_some_and(toml_edit::Array::is_empty) {
                *entries = Item::ArrayOfTables(ArrayOfTables::new());
            }
            let entries = entries
                .as_array_of_tables_mut()
                .ok_or_else(|| CoreError::config("Expected connection tables"))?;
            let id = profile.id.to_string();
            if let Some(table) = entries
                .iter_mut()
                .find(|table| table.get("id").and_then(Item::as_str) == Some(&id))
            {
                merge(table, encoded.as_table());
            } else {
                entries.push(encoded.into_table());
            }
            Ok(())
        })
    }

    pub fn delete_profile(&self, id: &str) -> Result<()> {
        self.edit(|document| {
            if let Some(entries) = document
                .get_mut("connection")
                .and_then(Item::as_array_of_tables_mut)
            {
                let index = entries
                    .iter()
                    .position(|table| table.get("id").and_then(Item::as_str) == Some(id));
                if let Some(index) = index {
                    entries.remove(index);
                }
            }
            Ok(())
        })
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        let encoded = toml_edit::ser::to_document(settings)
            .map_err(|_| CoreError::config("Cannot encode settings"))?;
        self.edit(|document| {
            let table = document
                .entry("settings")
                .or_insert(Item::Table(Table::new()));
            let table = table
                .as_table_mut()
                .ok_or_else(|| CoreError::config("Expected a settings table"))?;
            merge(table, encoded.as_table());
            Ok(())
        })
    }

    fn read(&self) -> Result<String> {
        match fs::read_to_string(&self.path) {
            Ok(text) => Ok(text),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok("version = 1\n".into()),
            Err(error) => Err(io_error(error)),
        }
    }

    fn edit(&self, operation: impl FnOnce(&mut DocumentMut) -> Result<()>) -> Result<()> {
        let parent = self
            .path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent).map_err(io_error)?;
        let lock = File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .read(true)
            .open(parent.join("config.lock"))
            .map_err(io_error)?;
        lock.lock().map_err(io_error)?;
        let text = self.read()?;
        Config::parse(&text)?;
        let mut document = text
            .parse::<DocumentMut>()
            .map_err(|_| CoreError::config("Cannot edit config.toml"))?;
        operation(&mut document)?;
        let updated = document.to_string();
        Config::parse(&updated)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(io_error)?;
        temporary.write_all(updated.as_bytes()).map_err(io_error)?;
        temporary.as_file().sync_all().map_err(io_error)?;
        temporary.persist(&self.path).map_err(io_error)?;
        #[cfg(unix)]
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(io_error)?;
        Ok(())
    }
}

fn merge(current: &mut Table, updated: &Table) {
    current.retain(|key, _| updated.contains_key(key));
    for (key, item) in updated.iter() {
        if let Some(previous) = current.get_mut(key) {
            if let (Some(previous), Some(updated)) = (previous.as_table_mut(), item.as_table()) {
                merge(previous, updated);
                continue;
            }
            if let (Some(previous), Some(next)) = (previous.as_value_mut(), item.as_value()) {
                let decor = previous.decor().clone();
                *previous = next.clone();
                *previous.decor_mut() = decor;
                continue;
            }
            *previous = item.clone();
        } else {
            current.insert(key, item.clone());
        }
    }
}

fn publish_config(sender: &watch::Sender<ConfigUpdate>, loaded: Result<Config>) {
    sender.send_modify(move |snapshot| match loaded {
        Ok(config) => {
            *snapshot = ConfigUpdate {
                config,
                error: None,
            }
        }
        Err(error) => snapshot.error = Some(error.to_string()),
    });
}
