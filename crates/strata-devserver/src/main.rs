use std::{env, error::Error};

use axum::{
    Json, Router,
    extract::{
        State,
        ws::{Message, WebSocketUpgrade},
    },
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::Response,
    routing::{get, post},
};
use strata_app::{AppService, Health};
use tower_http::cors::CorsLayer;

struct DevState {
    app: AppService,
    origin: HeaderValue,
    authorization: HeaderValue,
    ws_protocol: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    use std::sync::Arc;

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
        .route("/ws", get(websocket))
        .layer(cors)
        .with_state(Arc::new(DevState {
            app: AppService,
            origin,
            authorization: HeaderValue::from_str(&format!("Bearer {token}"))?,
            ws_protocol: format!("strata.{token}"),
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
    if headers
        .get(header::ORIGIN)
        .is_some_and(|origin| origin != state.origin)
    {
        return Err(StatusCode::FORBIDDEN);
    }
    if headers.get(header::AUTHORIZATION) != Some(&state.authorization) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(Json(state.app.health()))
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
            while let Some(Ok(message)) = socket.recv().await {
                if matches!(message, Message::Close(_)) {
                    break;
                }
            }
        }))
}
