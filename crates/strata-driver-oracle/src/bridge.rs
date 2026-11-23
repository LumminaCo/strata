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
        let binary = if let Some(binary) = std::env::var_os("STRATA_ORACLE_BRIDGE") {
            PathBuf::from(binary)
        } else {
            let executable = std::env::current_exe()
                .map_err(|_| error("Cannot locate the Strata executable"))?;
            executable.with_file_name(if cfg!(windows) {
                "oracle-bridge.exe"
            } else {
                "oracle-bridge"
            })
        };
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
