import { Database, FlaskConical, Link2 } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { Connection, DriverOptions } from "@/ipc/bindings/protocol";
import { browserMode, dispatch, errorMessage } from "@/ipc/client";

export const emptyConnection: Connection = {
  id: null,
  name: "",
  kind: "postgres",
  env: "dev",
  host: "",
  port: 5432,
  database: "postgres",
  user: "",
  secret: "prompt",
  readOnly: false,
  agentAccess: "none",
  allowAgentDdl: false,
  tls: "prefer",
  color: null,
  options: null,
  folder: null,
};

const emptyOptions: DriverOptions = {
  instance: null,
  auth: null,
  encrypt: null,
  encryption: null,
  trust_server_cert: null,
  service_name: null,
  sid: null,
  descriptor: null,
  role: null,
  wallet: null,
};

export interface ConnectionFormProps {
  initial: Connection;
  onSave: (profile: Connection, enteredPassword?: string) => void;
  onCancel?: () => void;
  onBusyChange?: (busy: boolean) => void;
  footer?: "dialog" | "inline";
}

export function ConnectionForm({
  initial,
  onSave,
  onCancel,
  onBusyChange,
  footer = "dialog",
}: ConnectionFormProps) {
  const [profile, setProfile] = useState(initial);
  const [password, setPassword] = useState<string>();
  const [url, setUrl] = useState("");
  const [envVariable, setEnvVariable] = useState(
    initial.secret.startsWith("env:") ? initial.secret.slice(4) : "",
  );
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean }>();
  const options = profile.options ?? emptyOptions;
  const windowsAuth = profile.kind === "sqlserver" && options.auth === "windows";
  const source = windowsAuth
    ? "windows"
    : profile.secret.startsWith("env:")
      ? "env"
      : profile.secret;

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  function option<K extends keyof DriverOptions>(key: K, value: DriverOptions[K]) {
    field("options", { ...options, [key]: value });
  }

  function field<K extends keyof Connection>(key: K, value: Connection[K]) {
    setProfile((current) => ({ ...current, [key]: value }));
    setFeedback(undefined);
  }

  function connection() {
    return {
      ...profile,
      secret:
        source === "env" ? `env:${envVariable.trim()}` : source === "windows" ? "prompt" : source,
    };
  }

  async function action(work: () => Promise<void>) {
    setBusy(true);
    setFeedback(undefined);
    try {
      await work();
    } catch (error) {
      setFeedback({ text: errorMessage(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void action(async () => {
      const saved = await dispatch("save_connection", { profile: connection(), password });
      onSave(saved, source === "prompt" ? password : undefined);
    });
  }

  function test() {
    void action(async () => {
      const result = await dispatch("test_connection", { profile: connection(), password });
      setFeedback({ text: `${result.version} · ${result.elapsedMs} ms` });
    });
  }

  function paste() {
    void action(async () => {
      const { password: parsedPassword, ...details } = await dispatch("parse_connection_url", {
        url,
      });
      if (initial.id && details.kind !== initial.kind)
        throw new Error("The URL uses a different database driver.");
      setProfile((current) => ({
        ...current,
        ...details,
        name: current.name || details.database || details.host,
        ...(parsedPassword === null ? {} : { secret: "prompt" }),
      }));
      if (parsedPassword !== null) setPassword(parsedPassword);
      setUrl("");
    });
  }

  function oracleFixture() {
    setProfile({
      ...emptyConnection,
      id: profile.id,
      name: "Local Oracle",
      kind: "oracle",
      host: "oracle",
      port: 1521,
      database: "FREEPDB1",
      user: "hr",
      secret: "env:ORACLE_APP_PASSWORD",
    });
    setEnvVariable("ORACLE_APP_PASSWORD");
    setPassword(undefined);
    setFeedback(undefined);
  }

  function sqlServerFixture() {
    setProfile({
      ...emptyConnection,
      id: profile.id,
      name: "Local SQL Server",
      kind: "sqlserver",
      host: "mssql",
      port: 1433,
      database: "AdventureWorksLT2022",
      user: "sa",
      secret: "env:SQLCMDPASSWORD",
      options: { ...emptyOptions, encryption: "on", trust_server_cert: true },
    });
    setEnvVariable("SQLCMDPASSWORD");
    setPassword(undefined);
    setFeedback(undefined);
  }

  function localFixture() {
    setProfile({
      ...emptyConnection,
      id: profile.id,
      name: "Local PostgreSQL",
      host: "postgres",
      database: "pagila",
      user: "postgres",
      secret: "env:POSTGRES_PASSWORD",
    });
    setEnvVariable("POSTGRES_PASSWORD");
    setPassword(undefined);
    setFeedback(undefined);
  }

  const actions = (
    <>
      {footer === "inline" && onCancel && (
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      )}
      <Button type="button" variant="outline" disabled={busy} onClick={test}>
        <FlaskConical /> Test connection
      </Button>
      <Button type="submit" disabled={busy}>
        Save connection
      </Button>
    </>
  );

  return (
    <>
      <div className="url-row">
        <Input
          aria-label="Connection URL"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="PostgreSQL, SQL Server, or Oracle URL"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Button type="button" variant="outline" disabled={busy || !url.trim()} onClick={paste}>
          <Link2 /> Paste URL
        </Button>
      </div>
      {browserMode && import.meta.env.DEV && !initial.id && (
        <div className="toolbar-actions">
          <Button
            type="button"
            variant="ghost"
            className="fixture-button"
            disabled={busy}
            onClick={localFixture}
          >
            <Database /> Use local PostgreSQL
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="fixture-button"
            disabled={busy}
            onClick={sqlServerFixture}
          >
            <Database /> Use local SQL Server
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="fixture-button"
            disabled={busy}
            onClick={oracleFixture}
          >
            <Database /> Use local Oracle
          </Button>
        </div>
      )}
      <form onSubmit={save} className="connection-form">
        <fieldset disabled={busy} className="connection-fields">
          <Field name="connection-kind" label="Driver">
            <NativeSelect
              id="connection-kind"
              value={profile.kind}
              disabled={!!initial.id}
              onChange={(event) => {
                const kind = event.target.value as Connection["kind"];
                setProfile((current) => ({
                  ...current,
                  kind,
                  options: null,
                  port: kind === "sqlserver" ? 1433 : kind === "oracle" ? 1521 : 5432,
                  database:
                    kind === "sqlserver" ? "master" : kind === "oracle" ? "FREEPDB1" : "postgres",
                }));
              }}
            >
              <NativeSelectOption value="postgres">PostgreSQL</NativeSelectOption>
              <NativeSelectOption value="sqlserver">SQL Server</NativeSelectOption>
              <NativeSelectOption value="oracle">Oracle</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field name="connection-name" label="Name">
            <Input
              id="connection-name"
              required
              value={profile.name}
              onChange={(event) => field("name", event.target.value)}
            />
          </Field>
          <Field name="connection-env" label="Environment">
            <NativeSelect
              id="connection-env"
              value={profile.env}
              onChange={(event) => field("env", event.target.value as Connection["env"])}
            >
              <NativeSelectOption value="dev">Development</NativeSelectOption>
              <NativeSelectOption value="staging">Staging</NativeSelectOption>
              <NativeSelectOption value="prod">Production</NativeSelectOption>
            </NativeSelect>
          </Field>
          <div className="endpoint-fields">
            <Field name="connection-host" label="Host">
              <Input
                id="connection-host"
                required
                value={profile.host}
                onChange={(event) => field("host", event.target.value)}
              />
            </Field>
            <Field name="connection-port" label="Port">
              <Input
                id="connection-port"
                type="number"
                min={1}
                max={65535}
                required
                value={profile.port || ""}
                onChange={(event) => field("port", Number(event.target.value))}
              />
            </Field>
          </div>
          <Field
            name="connection-db"
            label={profile.kind === "oracle" ? "Service name" : "Database"}
          >
            <Input
              id="connection-db"
              required
              value={profile.database}
              onChange={(event) => field("database", event.target.value)}
            />
          </Field>
          <Field name="connection-user" label="User">
            <Input
              id="connection-user"
              required={!windowsAuth}
              disabled={windowsAuth}
              value={profile.user}
              onChange={(event) => field("user", event.target.value)}
            />
          </Field>
          <Field name="connection-secret" label="Authentication">
            <NativeSelect
              id="connection-secret"
              value={source}
              onChange={(event) => {
                const chosen = event.target.value;
                setProfile((current) => ({
                  ...current,
                  secret: chosen === "env" ? "env:" : chosen === "windows" ? "prompt" : chosen,
                  options:
                    current.kind === "sqlserver"
                      ? { ...options, auth: chosen === "windows" ? "windows" : null }
                      : current.options,
                }));
                setPassword(undefined);
              }}
            >
              <NativeSelectOption value="prompt">Prompt for password</NativeSelectOption>
              {!browserMode && (
                <NativeSelectOption value="keychain">OS keychain</NativeSelectOption>
              )}
              <NativeSelectOption value="env">Environment variable</NativeSelectOption>
              {profile.kind === "sqlserver" &&
                !browserMode &&
                navigator.userAgent.includes("Windows") && (
                  <NativeSelectOption value="windows">Windows integrated</NativeSelectOption>
                )}
            </NativeSelect>
          </Field>
          {source === "env" ? (
            <Field name="connection-variable" label="Variable name">
              <Input
                id="connection-variable"
                required
                value={envVariable}
                placeholder="PG_PASSWORD"
                onChange={(event) => setEnvVariable(event.target.value)}
              />
            </Field>
          ) : (
            !windowsAuth && (
              <Field name="connection-password" label="Password">
                <Input
                  id="connection-password"
                  type="password"
                  autoComplete="off"
                  value={password ?? ""}
                  placeholder={
                    initial.secret === "keychain" && initial.id
                      ? "Keep saved password"
                      : "Enter to test or open"
                  }
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
            )
          )}
          {profile.kind === "sqlserver" ? (
            <>
              <Field name="connection-instance" label="Named instance">
                <Input
                  id="connection-instance"
                  value={options.instance ?? ""}
                  onChange={(event) => option("instance", event.target.value || null)}
                />
              </Field>
              <Field name="connection-encrypt" label="Encryption">
                <NativeSelect
                  id="connection-encrypt"
                  value={options.encryption ?? (options.encrypt === false ? "off" : "on")}
                  onChange={(event) => option("encryption", event.target.value)}
                >
                  <NativeSelectOption value="on">On</NativeSelectOption>
                  <NativeSelectOption value="off">Off</NativeSelectOption>
                  <NativeSelectOption value="strict">Strict</NativeSelectOption>
                </NativeSelect>
              </Field>
              <Label className="read-only-field">
                <input
                  type="checkbox"
                  checked={!!options.trust_server_cert && options.encryption !== "strict"}
                  disabled={options.encryption === "strict"}
                  onChange={(event) => option("trust_server_cert", event.target.checked)}
                />
                Trust server certificate
              </Label>
            </>
          ) : (
            <Field name="connection-tls" label="TLS">
              <NativeSelect
                id="connection-tls"
                value={profile.tls}
                onChange={(event) => field("tls", event.target.value as Connection["tls"])}
              >
                <NativeSelectOption value="prefer">Prefer</NativeSelectOption>
                <NativeSelectOption value="disable">Disable</NativeSelectOption>
                <NativeSelectOption value="require">Require</NativeSelectOption>
                <NativeSelectOption value="verify-ca">Verify CA</NativeSelectOption>
                <NativeSelectOption value="verify-full">Verify full</NativeSelectOption>
              </NativeSelect>
            </Field>
          )}
          {profile.kind === "oracle" && (
            <>
              <Field name="connection-sid" label="SID (optional)">
                <Input
                  id="connection-sid"
                  value={options.sid ?? ""}
                  onChange={(event) => option("sid", event.target.value || null)}
                />
              </Field>
              <Field name="connection-role" label="Oracle role">
                <NativeSelect
                  id="connection-role"
                  value={options.role ?? ""}
                  onChange={(event) => option("role", event.target.value || null)}
                >
                  <NativeSelectOption value="">Default</NativeSelectOption>
                  <NativeSelectOption value="SYSDBA">SYSDBA</NativeSelectOption>
                  <NativeSelectOption value="SYSOPER">SYSOPER</NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field name="connection-descriptor" label="TNS descriptor (optional)">
                <Input
                  id="connection-descriptor"
                  value={options.descriptor ?? ""}
                  onChange={(event) => option("descriptor", event.target.value || null)}
                />
              </Field>
              <Field name="connection-wallet" label="Wallet path (optional)">
                <Input
                  id="connection-wallet"
                  value={options.wallet ?? ""}
                  onChange={(event) => option("wallet", event.target.value || null)}
                />
              </Field>
            </>
          )}
          <Field name="connection-folder" label="Folder">
            <Input
              id="connection-folder"
              value={profile.folder ?? ""}
              onChange={(event) => field("folder", event.target.value)}
            />
          </Field>
          <Field name="connection-color" label="Color">
            <NativeSelect
              id="connection-color"
              value={profile.color ?? ""}
              onChange={(event) => field("color", event.target.value || null)}
            >
              <NativeSelectOption value="">Environment default</NativeSelectOption>
              <NativeSelectOption value="blue">Blue</NativeSelectOption>
              <NativeSelectOption value="green">Green</NativeSelectOption>
              <NativeSelectOption value="amber">Amber</NativeSelectOption>
              <NativeSelectOption value="red">Red</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field name="connection-agent" label="Agent access">
            <NativeSelect
              id="connection-agent"
              value={profile.agentAccess}
              onChange={(event) =>
                field("agentAccess", event.target.value as Connection["agentAccess"])
              }
            >
              <NativeSelectOption value="none">Disabled</NativeSelectOption>
              <NativeSelectOption value="read">Read</NativeSelectOption>
              <NativeSelectOption
                value="write"
                disabled={profile.env === "prod" || profile.readOnly}
              >
                Read and write
              </NativeSelectOption>
            </NativeSelect>
          </Field>
          {profile.agentAccess === "write" && profile.env !== "prod" && !profile.readOnly && (
            <Label className="read-only-field">
              <input
                type="checkbox"
                checked={profile.allowAgentDdl}
                onChange={(event) => field("allowAgentDdl", event.target.checked)}
              />
              Allow agent DDL
            </Label>
          )}
          <Label className="read-only-field">
            <input
              type="checkbox"
              checked={profile.readOnly}
              onChange={(event) => field("readOnly", event.target.checked)}
            />
            Read-only
          </Label>
        </fieldset>
        {feedback && (
          <p className="dialog-feedback" role={feedback.error ? "alert" : "status"}>
            {feedback.text}
          </p>
        )}
        {footer === "dialog" ? (
          <DialogFooter>{actions}</DialogFooter>
        ) : (
          <div className="connection-inline-footer">{actions}</div>
        )}
      </form>
    </>
  );
}

interface ConnectionDialogProps {
  initial: Connection;
  onSave: (profile: Connection, enteredPassword?: string) => void;
  onClose: () => void;
}

export function ConnectionDialog({ initial, onSave, onClose }: ConnectionDialogProps) {
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="connection-dialog" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{initial.id ? "Edit connection" : "New connection"}</DialogTitle>
          <DialogDescription>Configure a database connection.</DialogDescription>
        </DialogHeader>
        <ConnectionForm initial={initial} onSave={onSave} onBusyChange={setBusy} footer="dialog" />
      </DialogContent>
    </Dialog>
  );
}

function Field({ name, label, children }: { name: string; label: string; children: ReactNode }) {
  return (
    <div className="connection-field">
      <Label htmlFor={name}>{label}</Label>
      {children}
    </div>
  );
}

export function PasswordDialog({
  name,
  onClose,
  onSubmit,
}: {
  name: string;
  onClose: () => void;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect to {name}</DialogTitle>
          <DialogDescription>Enter the database password for this session.</DialogDescription>
        </DialogHeader>
        <form
          className="connection-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(password);
          }}
        >
          <Field name="session-password" label="Password">
            <Input
              id="session-password"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="submit">Connect</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Confirmation({
  title,
  description,
  action,
  sql,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  action: string;
  sql?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {sql && <pre className="confirmation-sql">{sql}</pre>}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
