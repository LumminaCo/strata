//! Commands shared by the desktop and browser development transports.

use serde::Serialize;

#[derive(Default)]
pub struct AppService;

#[derive(Serialize)]
pub struct Health {
    pub version: &'static str,
}

impl AppService {
    pub fn health(&self) -> Health {
        Health {
            version: env!("CARGO_PKG_VERSION"),
        }
    }
}
