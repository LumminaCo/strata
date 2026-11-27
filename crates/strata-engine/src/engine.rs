use std::sync::Arc;

use strata_core::{Core, CoreError, Driver, Introspector, Limits, Profile, Result, Secret};
use strata_driver_mssql::SqlServer;
use strata_driver_oracle::Oracle;
use strata_driver_postgres::Postgres;
use strata_store::{
    Config, ConfigStore, ConfigUpdate, Database, HistoryEntry, Keychain, Paths, WatchedConfig,
};
use tokio::sync::watch;
use uuid::Uuid;

/// Common headless Rust entry point for open profiles, sessions and the persistent store.
pub struct Engine {
    pub(crate) paths: Paths,
    config: WatchedConfig,
    core: Core,
    drivers: Vec<Arc<dyn Driver>>,
}

impl Engine {
    pub fn open(paths: Paths) -> Result<Self> {
        let config = ConfigStore::new(paths.config.clone()).watch()?;
        let settings = config.updates().borrow().config.settings.clone();
        Database::open(&paths.database)?;
        let limits = settings.limits();
        let drivers: Vec<Arc<dyn Driver>> = vec![
            Arc::new(Postgres),
            Arc::new(SqlServer),
            Arc::new(Oracle::default()),
        ];
        let core = Core::new(drivers.iter().cloned(), limits)?;
        Ok(Self {
            paths,
            config,
            core,
            drivers,
        })
    }

    pub fn paths(&self) -> &Paths {
        &self.paths
    }

    pub fn core_with_limits(&self, limits: Limits) -> Result<Core> {
        Core::new(self.drivers.iter().cloned(), limits)
    }

    pub async fn connection_secret(&self, profile: Profile) -> Result<Secret> {
        resolve_secret(profile, None)
            .await
            .map(|(_, secret)| secret)
    }

    pub async fn save_settings(&self, settings: strata_store::Settings) -> Result<()> {
        let store = self.config_store();
        tokio::task::spawn_blocking(move || store.save_settings(&settings))
            .await
            .map_err(background_error)?
    }

    pub async fn begin_audit(&self, entry: strata_store::AuditEntry) -> Result<i64> {
        let path = self.paths.database.clone();
        tokio::task::spawn_blocking(move || Database::open(&path)?.begin_audit(&entry))
            .await
            .map_err(background_error)?
    }

    pub async fn finish_audit(&self, id: i64, outcome: strata_store::AuditOutcome) -> Result<()> {
        let path = self.paths.database.clone();
        tokio::task::spawn_blocking(move || Database::open(&path)?.finish_audit(id, &outcome))
            .await
            .map_err(background_error)?
    }

    pub async fn audit(&self, limit: u32) -> Result<Vec<strata_store::AuditEntry>> {
        let path = self.paths.database.clone();
        tokio::task::spawn_blocking(move || Database::open(&path)?.audit(limit))
            .await
            .map_err(background_error)?
    }

    pub fn config_updates(&self) -> watch::Receiver<ConfigUpdate> {
        self.config.updates()
    }

    pub fn config_store(&self) -> ConfigStore {
        ConfigStore::new(self.paths.config.clone())
    }

    pub fn core(&self) -> &Core {
        &self.core
    }

    pub fn config(&self) -> Config {
        self.config_store()
            .load()
            .unwrap_or_else(|_| self.config.updates().borrow().config.clone())
    }

    pub fn profile(&self, id: Uuid) -> Result<Profile> {
        self.config()
            .connections
            .into_iter()
            .find(|profile| profile.id == id)
            .ok_or_else(|| CoreError::config("Connection profile does not exist"))
    }

    pub async fn open_session(&self, id: Uuid, prompted: Option<Secret>) -> Result<Uuid> {
        let profile = self.profile(id)?;
        let (profile, secret) = resolve_secret(profile, prompted).await?;
        self.core
            .open_session_with_limits(&profile, &secret, self.config().settings.limits())
            .await
    }

    pub async fn introspector(
        &self,
        id: Uuid,
        prompted: Option<Secret>,
    ) -> Result<Box<dyn Introspector>> {
        self.introspector_in(id, None, prompted).await
    }

    pub async fn introspector_in(
        &self,
        id: Uuid,
        database: Option<&str>,
        prompted: Option<Secret>,
    ) -> Result<Box<dyn Introspector>> {
        let mut profile = self.profile(id)?;
        if let Some(database) = database {
            profile.database = database.into();
        }
        let (profile, secret) = resolve_secret(profile, prompted).await?;
        self.core.introspector(&profile, &secret).await
    }

    pub async fn open_profile(&self, profile: Profile, supplied: Option<Secret>) -> Result<Uuid> {
        let (profile, secret) = match supplied {
            Some(secret) => (profile, secret),
            None => resolve_secret(profile, None).await?,
        };
        self.core
            .open_session_with_limits(&profile, &secret, self.config().settings.limits())
            .await
    }

    pub async fn workspace(&self) -> Result<Option<String>> {
        let path = self.paths.database.clone();
        tokio::task::spawn_blocking(move || Database::open(&path)?.load_workspace())
            .await
            .map_err(background_error)?
    }

    pub async fn save_workspace(&self, json: String) -> Result<()> {
        let path = self.paths.database.clone();
        tokio::task::spawn_blocking(move || Database::open(&path)?.save_workspace(&json))
            .await
            .map_err(background_error)?
    }

    pub async fn history(&self, profile: Uuid, limit: u32) -> Result<Vec<HistoryEntry>> {
        let path = self.paths.database.clone();
        tokio::task::spawn_blocking(move || {
            Database::open(&path)?.history(&profile.to_string(), limit)
        })
        .await
        .map_err(background_error)?
    }

    pub async fn record_history(&self, entry: HistoryEntry) -> Result<()> {
        let path = self.paths.database.clone();
        tokio::task::spawn_blocking(move || Database::open(&path)?.record_history(&entry))
            .await
            .map_err(background_error)?
    }
}

async fn resolve_secret(profile: Profile, prompted: Option<Secret>) -> Result<(Profile, Secret)> {
    tokio::task::spawn_blocking(move || {
        let secret = if profile.options.auth.as_deref() == Some("windows") {
            Secret::new(String::new())
        } else {
            Keychain::resolve(&profile, prompted)?
        };
        Ok((profile, secret))
    })
    .await
    .map_err(background_error)?
}

pub(crate) fn background_error(_: tokio::task::JoinError) -> CoreError {
    CoreError::Io {
        message: "Local storage task failed".into(),
    }
}
