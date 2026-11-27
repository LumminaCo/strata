use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use strata_core::{CoreError, Result};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, Command},
    sync::{Mutex as AsyncMutex, oneshot},
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct Supervisor(AsyncMutex<Option<Arc<Bridge>>>);

impl Supervisor {
    pub async fn bridge(&self) -> Result<Arc<Bridge>> {
        let mut state = self.0.lock().await;
        if let Some(bridge) = state.as_ref().filter(|bridge| !bridge.closed()) {
            return Ok(bridge.clone());
        }
        let bridge = Bridge::start()?;
        let hello = tokio::time::timeout(
            Duration::from_secs(5),
            bridge.rpc::<Value>("hello", json!({})),
        )
        .await
        .map_err(|_| CoreError::Timeout)??;
        if hello["version"] != 1 {
            bridge.shutdown.cancel();
            return Err(error("Oracle bridge protocol version mismatch"));
        }
        *state = Some(bridge.clone());
        Ok(bridge)
    }
}

#[derive(Deserialize)]
struct Message {
    id: u64,
    result: Option<Value>,
    error: Option<Failure>,
}

#[derive(Deserialize)]
struct Failure {
    code: String,
    message: String,
}

pub struct Bridge {
    input: AsyncMutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Message>>>>,
    next: AtomicU64,
    ended: CancellationToken,
    shutdown: CancellationToken,
}

impl Bridge {
    fn start() -> Result<Arc<Self>> {
        let binary = resolve_bridge_binary()?;
        let mut child = Command::new(binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| error("Cannot start the Oracle bridge"))?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| error("Oracle bridge input is unavailable"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| error("Oracle bridge output is unavailable"))?;
        let pending = Arc::new(Mutex::new(HashMap::<u64, oneshot::Sender<Message>>::new()));
        let ended = CancellationToken::new();
        let shutdown = CancellationToken::new();
        let read_pending = pending.clone();
        let read_ended = ended.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(output).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(response) = serde_json::from_str::<Message>(&line) else {
                    break;
                };
                if let Some(request) = read_pending
                    .lock()
                    .expect("Oracle bridge pending requests")
                    .remove(&response.id)
                {
                    let _ = request.send(response);
                }
            }
            read_ended.cancel();
            read_pending
                .lock()
                .expect("Oracle bridge pending requests")
                .clear();
        });
        let stop = shutdown.clone();
        let exited = ended.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = child.wait() => {}
                _ = stop.cancelled() => { let _ = child.kill().await; }
                _ = exited.cancelled() => { let _ = child.kill().await; }
            }
            exited.cancel();
        });
        Ok(Arc::new(Self {
            input: AsyncMutex::new(input),
            pending,
            next: AtomicU64::new(1),
            ended,
            shutdown,
        }))
    }

    pub fn closed(&self) -> bool {
        self.ended.is_cancelled()
    }

    pub async fn rpc<T: DeserializeOwned>(&self, method: &str, params: Value) -> Result<T> {
        if self.closed() {
            return Err(error("The Oracle bridge exited"));
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (send, receive) = oneshot::channel();
        self.pending
            .lock()
            .expect("Oracle bridge pending requests")
            .insert(id, send);
        let _pending = Pending {
            id,
            entries: &self.pending,
        };
        let mut frame =
            serde_json::to_vec(&json!({ "id": id, "method": method, "params": params }))
                .map_err(|_| error("Cannot encode Oracle request"))?;
        frame.push(b'\n');
        self.input
            .lock()
            .await
            .write_all(&frame)
            .await
            .map_err(|_| error("Cannot send request to Oracle bridge"))?;
        let reply = tokio::select! {
            biased;
            reply = receive => reply.map_err(|_| error("Oracle bridge response was interrupted"))?,
            _ = self.ended.cancelled() => return Err(error("The Oracle bridge exited")),
        };
        if let Some(failure) = reply.error {
            return Err(failure.into());
        }
        serde_json::from_value(reply.result.unwrap_or(Value::Null))
            .map_err(|_| error("Invalid Oracle bridge response"))
    }

    #[cfg(test)]
    pub async fn terminate(&self) {
        self.shutdown.cancel();
        self.ended.cancelled().await;
    }
}

struct Pending<'a> {
    id: u64,
    entries: &'a Mutex<HashMap<u64, oneshot::Sender<Message>>>,
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.entries
            .lock()
            .expect("Oracle bridge pending requests")
            .remove(&self.id);
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

fn error(message: &str) -> CoreError {
    CoreError::Bridge {
        message: message.into(),
    }
}

fn bridge_binary_name() -> &'static str {
    if cfg!(windows) {
        "oracle-bridge.exe"
    } else {
        "oracle-bridge"
    }
}

fn resolve_bridge_from(
    env_override: Option<PathBuf>,
    current_exe: Option<PathBuf>,
) -> Result<PathBuf> {
    if let Some(binary) = env_override.filter(|path| !path.as_os_str().is_empty()) {
        return Ok(binary);
    }
    let executable = current_exe.ok_or_else(|| error("Cannot locate the Strata executable"))?;
    let name = bridge_binary_name();
    if let Ok(canonical) = std::fs::canonicalize(&executable) {
        let candidate = canonical.with_file_name(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Ok(executable.with_file_name(name))
}

fn resolve_bridge_binary() -> Result<PathBuf> {
    resolve_bridge_from(
        std::env::var_os("STRATA_ORACLE_BRIDGE").map(PathBuf::from),
        std::env::current_exe().ok(),
    )
}

impl From<Failure> for CoreError {
    fn from(error: Failure) -> Self {
        match error.code.as_str() {
            "auth" => Self::Auth,
            "cancelled" => Self::Cancelled,
            "timeout" => Self::Timeout,
            "connect" => Self::Connect {
                message: error.message,
            },
            "config" => Self::Config {
                message: error.message,
            },
            code if code.starts_with("ORA-") => Self::Db {
                code: error.code,
                message: error.message,
                detail: None,
                hint: None,
                position: None,
                line: None,
            },
            _ => Self::Bridge {
                message: error.message,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{bridge_binary_name, resolve_bridge_from};

    #[test]
    fn prefers_env_override_when_set() {
        let override_path = std::path::PathBuf::from("/custom/oracle-bridge");
        let resolved = resolve_bridge_from(
            Some(override_path.clone()),
            Some(std::path::PathBuf::from("/usr/bin/strata")),
        )
        .expect("resolve env override");
        assert_eq!(resolved, override_path);
    }

    #[cfg(unix)]
    #[test]
    fn resolves_bridge_next_to_canonicalized_symlink_target() {
        let dir =
            std::env::temp_dir().join(format!("strata-oracle-bridge-test-{}", std::process::id()));
        let real_dir = dir.join("real");
        let link_dir = dir.join("bin");
        std::fs::create_dir_all(&real_dir).unwrap();
        std::fs::create_dir_all(&link_dir).unwrap();
        let real_cli = real_dir.join("strata");
        let real_bridge = real_dir.join(bridge_binary_name());
        std::fs::write(&real_cli, b"").unwrap();
        std::fs::write(&real_bridge, b"").unwrap();
        let link_cli = link_dir.join("strata");
        let _ = std::fs::remove_file(&link_cli);
        std::os::unix::fs::symlink(&real_cli, &link_cli).unwrap();

        let resolved = resolve_bridge_from(None, Some(link_cli)).expect("resolve symlinked bridge");
        assert_eq!(
            resolved,
            std::fs::canonicalize(&real_bridge).expect("canonical bridge")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
