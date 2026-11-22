//! Audited MCP tools over the native Strata stdio entry point.

mod query;

use std::{
    collections::HashSet,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use rmcp::{
    ErrorData, RoleServer, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, Implementation, JsonObject,
        ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
    transport::stdio,
};
use serde::Deserialize;
use serde_json::{Value, json};
use strata_app::{CatalogScope, Engine, Metadata};
use strata_core::{AgentAccess, CoreError, DbKind, Environment, ObjectKind, Profile};
use strata_sql::Dialect;
use strata_store::{AuditEntry, AuditOutcome, Paths};

const MAX_OBJECTS: usize = 500;

pub async fn serve(only: HashSet<String>) -> Result<(), Box<dyn std::error::Error>> {
    let server = Strata {
        engine: Engine::open(Paths::discover()?)?,
        metadata: Metadata::default(),
        only,
    };
    server.serve(stdio()).await?.waiting().await?;
    Ok(())
}

struct Strata {
    engine: Engine,
    metadata: Metadata,
    only: HashSet<String>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    connection: Option<String>,
    database: Option<String>,
    schema: Option<String>,
    object: Option<String>,
    kinds: Option<Vec<ObjectKind>>,
    name_filter: Option<String>,
    query: Option<String>,
    sql: Option<String>,
    max_rows: Option<usize>,
    timeout_s: Option<u32>,
    dry_run: Option<bool>,
}

struct ToolResult {
    value: Value,
    rows: Option<u32>,
    class: Option<String>,
}

impl From<Value> for ToolResult {
    fn from(value: Value) -> Self {
        Self {
            value,
            rows: None,
            class: None,
        }
    }
}

struct Failure {
    decision: &'static str,
    message: &'static str,
    class: Option<String>,
}

impl Failure {
    fn deny(message: &'static str) -> Self {
        Self {
            decision: "denied",
            message,
            class: None,
        }
    }

    fn database(error: CoreError) -> Self {
        let message = match error {
            CoreError::Auth => "Database authentication failed",
            CoreError::Secret { .. } => "Connection credentials are unavailable",
            CoreError::Timeout => "The database operation timed out",
            CoreError::Cancelled => "The database operation was cancelled",
            CoreError::ReadOnlyViolation { .. } => "The connection is read-only",
            _ => "The database rejected or interrupted the operation",
        };
        Self {
            decision: "error",
            message,
            class: None,
        }
    }

    fn with_class(mut self, class: &str) -> Self {
        self.class = Some(class.into());
        self
    }
}

impl Strata {
    fn visible(&self) -> Vec<Profile> {
        self.engine
            .config()
            .connections
            .into_iter()
            .filter(|profile| {
                profile.agent_access != AgentAccess::None
                    && (self.only.is_empty() || self.only.contains(&profile.name))
            })
            .collect()
    }

    async fn execute(
        &self,
        tool: &str,
        args: Arguments,
        profiles: &[Profile],
        profile: Option<&Profile>,
        context: &RequestContext<RoleServer>,
    ) -> Result<ToolResult, Failure> {
        if tool == "list_connections" {
            return Ok(json!({ "connections": profiles.iter().map(|profile| json!({
                "name": profile.name, "kind": profile.kind, "env": profile.env, "database": profile.database,
                "agent_access": profile.agent_access, "available": profile.secret != "prompt" || profile.options.auth.as_deref() == Some("windows"),
            })).collect::<Vec<_>>() }).into());
        }
        if tool == "unknown" {
            return Err(Failure::deny("Unknown Strata tool"));
        }
        let profile = profile.ok_or(Failure::deny("The connection is unavailable to agents"))?;
        if profile.secret == "prompt" && profile.options.auth.as_deref() != Some("windows") {
            return Err(Failure::deny(
                "Use an OS keychain or environment variable for this connection before using MCP",
            ));
        }
        let secret = self
            .engine
            .connection_secret(profile.clone())
            .await
            .map_err(Failure::database)?;
        if matches!(tool, "run_query" | "run_write" | "explain_query") {
            let mut result = query::execute(
                &self.engine,
                profile.clone(),
                &args,
                tool,
                &secret,
                &context.ct,
            )
            .await?;
            sanitize(&mut result.value, &[secret.expose()]);
            return Ok(result);
        }

        let scope = CatalogScope {
            connection_id: profile.id,
            database: args.database,
            password: None,
        };
        let catalog = self
            .metadata
            .catalog(&self.engine, &scope)
            .await
            .map_err(Failure::database)?;
        let mut value = match tool {
            "list_schemas" => {
                json!({"schemas": catalog.schemas(false).await.map_err(Failure::database)?})
            }
            "list_objects" => {
                let schema = args
                    .schema
                    .ok_or(Failure::deny("A schema name is required"))?;
                let kinds = args.kinds.unwrap_or_default();
                let mut objects = catalog
                    .objects(&schema, &kinds)
                    .await
                    .map_err(Failure::database)?;
                let needle = args.name_filter.unwrap_or_default().to_lowercase();
                objects.retain(|object| object.name.to_lowercase().contains(&needle));
                let truncated = objects.len() > MAX_OBJECTS;
                objects.truncate(MAX_OBJECTS);
                json!({"objects": objects, "truncated": truncated})
            }
            "search_objects" => {
                let search = args
                    .query
                    .ok_or(Failure::deny("A search query is required"))?
                    .to_lowercase();
                let mut matches = Vec::new();
                let schemas = catalog.schemas(false).await.map_err(Failure::database)?;
                let mut truncated = schemas.len() > 100;
                for schema in schemas.into_iter().take(100) {
                    if context.ct.is_cancelled() {
                        return Err(Failure::database(CoreError::Cancelled));
                    }
                    let snapshot = self
                        .metadata
                        .snapshot(&self.engine, &scope, schema)
                        .await
                        .map_err(Failure::database)?;
                    for object in &snapshot.objects {
                        if fuzzy_match(
                            &format!("{}.{}", object.schema, object.name).to_lowercase(),
                            &search,
                        ) {
                            if matches.len() == MAX_OBJECTS {
                                truncated = true;
                                break;
                            }
                            matches.push(object.clone());
                        }
                    }
                    if matches.len() >= MAX_OBJECTS {
                        break;
                    }
                }
                json!({"objects": matches, "truncated": truncated})
            }
            "describe_table" | "get_ddl" => {
                let identifier = args
                    .object
                    .ok_or(Failure::deny("An object name is required"))?;
                let object = catalog
                    .resolve(&identifier)
                    .await
                    .map_err(Failure::database)?
                    .ok_or(Failure::deny("The object does not exist or is not visible"))?;
                if tool == "get_ddl" {
                    json!({"object": object, "ddl": catalog.ddl(&object).await.map_err(Failure::database)?})
                } else {
                    let detail = catalog
                        .table_detail(&object)
                        .await
                        .map_err(Failure::database)?;
                    json!({"object": object, "detail": detail})
                }
            }
            _ => return Err(Failure::deny("Unknown Strata tool")),
        };
        sanitize(&mut value, &[secret.expose()]);
        Ok(value.into())
    }
}

impl ServerHandler for Strata {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("strata", env!("CARGO_PKG_VERSION")))
            .with_instructions("Inspect configured connections, query permitted databases with capped results, and use explicitly enabled writes. Strata audits every tool call.")
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let mut tools = vec![
            tool(
                "list_connections",
                "List configured connections visible to this agent",
                &[],
                &[],
            ),
            tool(
                "list_schemas",
                "List schemas in a connection",
                &["connection"],
                &["database"],
            ),
            tool(
                "list_objects",
                "List objects in a schema",
                &["connection", "schema"],
                &["database", "kinds", "name_filter"],
            ),
            tool(
                "search_objects",
                "Search database objects by name",
                &["connection", "query"],
                &["database"],
            ),
            tool(
                "describe_table",
                "Read columns, keys, indexes, and references",
                &["connection", "object"],
                &["database"],
            ),
            tool(
                "get_ddl",
                "Read an object's definition",
                &["connection", "object"],
                &["database"],
            ),
            tool(
                "run_query",
                "Run one recognized read query with a row limit",
                &["connection", "sql"],
                &["database", "max_rows", "timeout_s"],
            ),
            tool(
                "explain_query",
                "Return the estimated plan for one read query",
                &["connection", "sql"],
                &["database", "max_rows", "timeout_s"],
            ),
        ];
        if self.visible().iter().any(|profile| {
            profile.agent_access == AgentAccess::Write
                && profile.env != Environment::Prod
                && !profile.read_only
        }) {
            tools.push(tool(
                "run_write",
                "Execute a single allowed write, optionally rolling it back",
                &["connection", "sql"],
                &["database", "dry_run", "timeout_s"],
            ));
        }
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let started = Instant::now();
        let profiles = self.visible();
        let tool = match request.name.as_ref() {
            name @ ("list_connections" | "list_schemas" | "list_objects" | "search_objects"
            | "describe_table" | "get_ddl" | "run_query" | "explain_query"
            | "run_write") => name,
            _ => "unknown",
        };
        let parsed = serde_json::from_value::<Arguments>(Value::Object(
            request.arguments.unwrap_or_default(),
        ));
        let args = parsed.as_ref().ok();
        let profile = args
            .and_then(|args| args.connection.as_deref())
            .and_then(|name| profiles.iter().find(|profile| name == profile.name));
        let secrets: Vec<String> = self
            .engine
            .config()
            .connections
            .iter()
            .filter_map(|profile| profile.secret.strip_prefix("env:"))
            .filter_map(|name| std::env::var(name).ok())
            .filter(|value| !value.is_empty())
            .collect();
        let masks: Vec<_> = secrets.iter().map(String::as_str).collect();
        let redact = |text: &str| {
            masks.iter().fold(text.to_owned(), |text, secret| {
                text.replace(secret, "[redacted]")
            })
        };
        let dialect = match profile.map(|profile| profile.kind) {
            Some(DbKind::SqlServer) => Dialect::SqlServer,
            Some(DbKind::Oracle) => Dialect::Oracle,
            _ => Dialect::Postgres,
        };
        let entry = AuditEntry {
            id: 0,
            ts: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64,
            client_name: context.client_info().map(|client| redact(&client.name)),
            connection_name: profile.map_or_else(|| "—".into(), |profile| redact(&profile.name)),
            tool: tool.into(),
            sql: args
                .and_then(|args| args.sql.as_deref())
                .map(|sql| redact(&strata_sql::audit_sql(sql, dialect))),
            class: None,
            decision: "pending".into(),
            reason: None,
            rows: None,
            duration_ms: None,
        };
        let id = self.engine.begin_audit(entry).await.map_err(|_| {
            ErrorData::internal_error("Could not start the Strata audit record", None)
        })?;
        let result = match parsed {
            Ok(args) => self.execute(tool, args, &profiles, profile, &context).await,
            Err(_) => Err(Failure::deny("Invalid tool arguments")),
        };
        let elapsed = started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32;
        let (response, outcome) = match result {
            Ok(mut result) => {
                sanitize(&mut result.value, &masks);
                (
                    CallToolResult::structured(result.value),
                    AuditOutcome {
                        class: result.class,
                        decision: "allowed",
                        reason: None,
                        rows: result.rows,
                        duration_ms: elapsed,
                    },
                )
            }
            Err(failure) => (
                CallToolResult::structured_error(
                    json!({"error": failure.message, "decision": failure.decision}),
                ),
                AuditOutcome {
                    class: failure.class,
                    decision: failure.decision,
                    reason: Some(failure.message.into()),
                    rows: None,
                    duration_ms: elapsed,
                },
            ),
        };
        self.engine.finish_audit(id, outcome).await.map_err(|_| {
            ErrorData::internal_error("Could not finish the Strata audit record", None)
        })?;
        Ok(response.into())
    }
}

fn fuzzy_match(value: &str, needle: &str) -> bool {
    let mut characters = value.chars();
    needle
        .chars()
        .all(|wanted| characters.any(|value| value == wanted))
}

fn sanitize(value: &mut Value, masks: &[&str]) {
    match value {
        Value::String(text) => {
            for mask in masks.iter().filter(|mask| !mask.is_empty()) {
                *text = text.replace(mask, "[redacted]");
            }
            if let Some((byte, _)) = text.char_indices().nth(4_000) {
                text.truncate(byte);
                text.push('…');
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| sanitize(item, masks)),
        Value::Object(values) => values.values_mut().for_each(|item| sanitize(item, masks)),
        _ => {}
    }
}

fn tool(
    name: &'static str,
    description: &'static str,
    required: &[&str],
    optional: &[&str],
) -> Tool {
    let properties: JsonObject = required
        .iter()
        .chain(optional)
        .map(|field| {
            let value = match *field {
                "max_rows" | "timeout_s" => json!({"type":"integer", "minimum":1}),
                "dry_run" => json!({"type":"boolean"}),
                "kinds" => json!({"type":"array", "items":{"type":"string"}}),
                _ => json!({"type":"string"}),
            };
            ((*field).to_owned(), value)
        })
        .collect();
    let schema = json!({"type":"object", "properties":properties, "required":required, "additionalProperties":false});
    Tool::new(
        name,
        description,
        schema.as_object().cloned().unwrap_or_default(),
    )
}
