use std::{collections::HashMap, env, error::Error, sync::Arc};

use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, State,
        ws::{Message, WebSocketUpgrade},
    },
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use strata_app::{AppService, Command, ErrorDto, Health, RunEvent, RunRequest};
use strata_core::CoreError;
use tokio::sync::{Mutex, mpsc};
use tokio_util::sync::CancellationToken;
use tower_http::cors::CorsLayer;
use uuid::Uuid;

struct DevState {
    app: AppService,
    origin: HeaderValue,
    authorization: HeaderValue,
    ws_protocol: String,
    sockets: Mutex<HashMap<Uuid, Client>>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    if env::var("STRATA_DEV").as_deref() != Ok("1") {
        return Err("Set STRATA_DEV=1 to enable the development server".into());
    }
    let token = env::var("STRATA_DEV_TOKEN")?;
    if token.is_empty()
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("STRATA_DEV_TOKEN must contain only ASCII letters, digits, '-' or '_'".into());
    }

    let origin = HeaderValue::from_static("http://localhost:5173");
    let cors = CorsLayer::new()
        .allow_origin(origin.clone())
        .allow_methods([Method::POST])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);
    let routes = Router::new()
        .route("/invoke/health", post(health))
        .route("/invoke/dispatch", post(dispatch))
        .route("/invoke/run_query", post(run_query))
        .route("/ws", get(websocket))
        .layer(DefaultBodyLimit::max(10_000_000))
        .layer(cors)
        .with_state(Arc::new(DevState {
            app: AppService::open(false)?,
            origin,
            authorization: HeaderValue::from_str(&format!("Bearer {token}"))?,
            ws_protocol: format!("strata.{token}"),
            sockets: Mutex::default(),
        }));

    let listener = tokio::net::TcpListener::bind("0.0.0.0:7420").await?;
    println!("Strata development server listening on port 7420");
    axum::serve(listener, routes).await?;
    Ok(())
}

async fn health(
    State(state): State<std::sync::Arc<DevState>>,
    headers: HeaderMap,
) -> Result<Json<Health>, StatusCode> {
    authorize(&state, &headers)?;
    Ok(Json(state.app.health()))
}

fn authorize(state: &DevState, headers: &HeaderMap) -> Result<(), StatusCode> {
    if headers
        .get(header::ORIGIN)
        .is_some_and(|origin| origin != state.origin)
    {
        return Err(StatusCode::FORBIDDEN);
    }
    if headers.get(header::AUTHORIZATION) != Some(&state.authorization) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(())
}

#[derive(Clone)]
struct Client {
    output: mpsc::Sender<Frame>,
    lifetime: CancellationToken,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Frame {
    channel_id: Uuid,
    event: RunEvent,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Invoke {
    connection_id: Uuid,
    request: Command,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Run {
    connection_id: Uuid,
    channel_id: Uuid,
    request: RunRequest,
}

async fn dispatch(
    State(state): State<Arc<DevState>>,
    headers: HeaderMap,
    Json(input): Json<Invoke>,
) -> Result<Json<Value>, InvokeError> {
    authorize(&state, &headers).map_err(InvokeError::Auth)?;
    let client = client(&state, input.connection_id).await?;
    state
        .app
        .dispatch(input.request, client.lifetime)
        .await
        .map(Json)
        .map_err(InvokeError::Command)
}

async fn run_query(
    State(state): State<Arc<DevState>>,
    headers: HeaderMap,
    Json(input): Json<Run>,
) -> Result<Json<()>, InvokeError> {
    authorize(&state, &headers).map_err(InvokeError::Auth)?;
    let client = client(&state, input.connection_id).await?;
    let channel_id = input.channel_id;
    state
        .app
        .run(input.request, |event| async {
            client
                .output
                .send(Frame { channel_id, event })
                .await
                .is_ok()
        })
        .await
        .map(Json)
        .map_err(InvokeError::Command)
}

async fn client(state: &DevState, id: Uuid) -> Result<Client, InvokeError> {
    state.sockets.lock().await.get(&id).cloned().ok_or_else(|| {
        InvokeError::Command(CoreError::config("The browser connection was closed").into())
    })
}

enum InvokeError {
    Auth(StatusCode),
    Command(ErrorDto),
}

impl IntoResponse for InvokeError {
    fn into_response(self) -> Response {
        match self {
            Self::Auth(status) => status.into_response(),
            Self::Command(error) => (StatusCode::UNPROCESSABLE_ENTITY, Json(error)).into_response(),
        }
    }
}

async fn websocket(
    State(state): State<std::sync::Arc<DevState>>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Result<Response, StatusCode> {
    if headers.get(header::ORIGIN) != Some(&state.origin) {
        return Err(StatusCode::FORBIDDEN);
    }
    let requested = headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok());
    if !requested.is_some_and(|value| {
        value
            .split(',')
            .any(|protocol| protocol.trim() == state.ws_protocol)
    }) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(upgrade
        .protocols([state.ws_protocol.clone()])
        .on_upgrade(|mut socket| async move {
            let (output, mut input) = mpsc::channel::<Frame>(8);
            let connection_id = Uuid::now_v7();
            let lifetime = CancellationToken::new();
            let ready = serde_json::json!({ "connectionId": connection_id }).to_string();
            state.sockets.lock().await.insert(
                connection_id,
                Client {
                    output,
                    lifetime: lifetime.clone(),
                },
            );
            if socket.send(Message::Text(ready.into())).await.is_ok() {
                loop {
                    tokio::select! {
                        message = socket.recv() => match message {
                            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                            _ => {}
                        },
                        frame = input.recv() => {
                            let Some(frame) = frame else { break };
                            let Ok(frame) = serde_json::to_string(&frame) else { break };
                            if socket.send(Message::Text(frame.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            }
            lifetime.cancel();
            state.sockets.lock().await.remove(&connection_id);
            drop(input);
            state.app.close_disconnected_sessions().await;
        }))
}
