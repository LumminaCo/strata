//! Local connection profiles, credential references and SQLite persistence.

mod config;
mod database;

use std::path::PathBuf;

use directories::ProjectDirs;
use strata_core::{CoreError, Profile, Result, Secret};

pub use config::{Config, ConfigStore, ConfigUpdate, Settings, Theme, WatchedConfig};
pub use database::{Database, HistoryEntry, HistoryStatus, Source};

#[derive(Clone, Debug)]
pub struct Paths {
    pub config: PathBuf,
    pub database: PathBuf,
}

impl Paths {
    pub fn discover() -> Result<Self> {
        if let Some(root) = std::env::var_os("STRATA_HOME") {
            if root.is_empty() {
                return Err(CoreError::config("STRATA_HOME must not be empty"));
            }
            return Ok(Self::under(PathBuf::from(root)));
        }
        let project = ProjectDirs::from("co", "Lummina", "Strata")
            .ok_or_else(|| CoreError::config("Cannot determine the Strata data directories"))?;
        Ok(Self {
            config: project.config_dir().join("config.toml"),
            database: project.data_dir().join("strata.db"),
        })
    }

    pub fn under(root: PathBuf) -> Self {
        Self {
            config: root.join("config.toml"),
            database: root.join("strata.db"),
        }
    }
}

pub struct Keychain;

impl Keychain {
    pub fn resolve(profile: &Profile, prompted: Option<Secret>) -> Result<Secret> {
        profile.validate()?;
        match profile.secret.as_str() {
            "keychain" => Self::entry(profile)?
                .get_password()
                .map(Secret::new)
                .map_err(keychain_error),
            "prompt" => prompted.ok_or_else(|| CoreError::Secret {
                message: "Enter the connection password".into(),
            }),
            source => {
                let name = source
                    .strip_prefix("env:")
                    .ok_or_else(|| CoreError::config("Unsupported secret source"))?;
                std::env::var(name)
                    .map(Secret::new)
                    .map_err(|_| CoreError::Secret {
                        message: format!("Environment variable {name} is missing or invalid"),
                    })
            }
        }
    }

    pub fn save(profile: &Profile, secret: &Secret) -> Result<()> {
        Self::entry(profile)?
            .set_password(secret.expose())
            .map_err(keychain_error)
    }

    pub fn delete(profile: &Profile) -> Result<()> {
        match Self::entry(profile)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(keychain_error(error)),
        }
    }

    fn entry(profile: &Profile) -> Result<keyring::Entry> {
        profile.validate()?;
        if profile.secret != "keychain" {
            return Err(CoreError::config(
                "The profile does not use the OS keychain",
            ));
        }
        keyring::Entry::new("strata", &profile.id.to_string()).map_err(keychain_error)
    }
}

fn keychain_error(error: keyring::Error) -> CoreError {
    CoreError::Secret {
        message: match error {
            keyring::Error::NoEntry => "The connection password is missing from the OS keychain",
            keyring::Error::NoStorageAccess(_) => {
                "Unlock the OS keychain to access this connection"
            }
            _ => "Could not access the OS keychain",
        }
        .into(),
    }
}

fn io_error(error: impl std::fmt::Display) -> CoreError {
    CoreError::Io {
        message: error.to_string(),
    }
}
