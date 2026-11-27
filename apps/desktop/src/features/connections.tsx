import { FlaskConical, Link2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { DatabaseIcon } from "@/components/database-icon";

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
import { Select } from "@/components/ui/select";
import type { Connection, DriverOptions } from "@/ipc/bindings/protocol";
import { browserMode, dispatch, errorMessage } from "@/ipc/client";

export function defaultConnectionSecret(isBrowserMode = browserMode): Connection["secret"] {
  return isBrowserMode ? "prompt" : "keychain";
}

export function secretAfterUrlPaste(
  currentSecret: Connection["secret"],
  parsedPassword: string | null,
  isBrowserMode = browserMode,
): Connection["secret"] {
  if (parsedPassword === null) return currentSecret;
  return defaultConnectionSecret(isBrowserMode);
}

export const emptyConnection: Connection = {
  id: null,
  name: "",
  kind: "postgres",
  env: "dev",
  host: "",
  port: 5432,
  database: "postgres",
  user: "",
  secret: defaultConnectionSecret(),
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

  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;

  useEffect(() => {
    onBusyChangeRef.current?.(busy);
    return () => {
      if (busy) onBusyChangeRef.current?.(false);
    };
  }, [busy]);

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
      const submittedPassword = source === "keychain" || source === "prompt" ? password : undefined;
      const saved = await dispatch("save_connection", {
        profile: connection(),
        password: submittedPassword,
      });
      onSave(saved, source === "prompt" ? submittedPassword : undefined);
    });
  }

  function test() {
    void action(async () => {
      const submittedPassword = source === "keychain" || source === "prompt" ? password : undefined;
      const result = await dispatch("test_connection", {
        profile: connection(),
        password: submittedPassword,
      });
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
        secret: secretAfterUrlPaste(current.secret, parsedPassword),
      }));
      if (parsedPassword !== null) setPassword(parsedPassword || undefined);
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
            <DatabaseIcon kind="postgres" /> Use local PostgreSQL
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="fixture-button"
            disabled={busy}
            onClick={sqlServerFixture}
          >
            <DatabaseIcon kind="sqlserver" /> Use local SQL Server
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="fixture-button"
            disabled={busy}
            onClick={oracleFixture}
          >
            <DatabaseIcon kind="oracle" /> Use local Oracle
          </Button>
        </div>
      )}
      <form onSubmit={save} className="connection-form">
        <fieldset disabled={busy} className="connection-fields">
          <Field name="connection-kind" label="Driver">
            <div className="driver-select">
              <DatabaseIcon kind={profile.kind} className="driver-select-icon" />
              <Select
                id="connection-kind"
                value={profile.kind}
                disabled={!!initial.id}
                onValueChange={(kind) => {
                  setProfile((current) => ({
                    ...current,
                    kind,
                    options: null,
                    port: kind === "sqlserver" ? 1433 : kind === "oracle" ? 1521 : 5432,
                    database:
                      kind === "sqlserver" ? "master" : kind === "oracle" ? "FREEPDB1" : "postgres",
                  }));
                }}
                items={[
                  { value: "postgres", label: "PostgreSQL" },
                  { value: "sqlserver", label: "SQL Server" },
                  { value: "oracle", label: "Oracle" },
                ]}
              />
            </div>
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
            <Select
              id="connection-env"
              value={profile.env}
              onValueChange={(env) => field("env", env)}
              items={[
                { value: "dev", label: "Development" },
                { value: "staging", label: "Staging" },
                { value: "prod", label: "Production" },
              ]}
            />
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
            <Select
              id="connection-secret"
              value={source}
              onValueChange={(chosen) => {
                setProfile((current) => ({
                  ...current,
                  secret: chosen === "env" ? "env:" : chosen === "windows" ? "prompt" : chosen,
                  options:
                    current.kind === "sqlserver"
                      ? { ...options, auth: chosen === "windows" ? "windows" : null }
                      : current.options,
                }));
                if (chosen === "env" || chosen === "windows") setPassword(undefined);
              }}
              items={[
                ...(browserMode ? [] : [{ value: "keychain", label: "OS keychain" }]),
                { value: "prompt", label: "Prompt for password" },
                { value: "env", label: "Environment variable" },
                ...(profile.kind === "sqlserver" &&
                !browserMode &&
                navigator.userAgent.includes("Windows")
                  ? [{ value: "windows", label: "Windows integrated" }]
                  : []),
              ]}
            />
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
              <Field
                name="connection-password"
                label={source === "prompt" ? "Password (session only)" : "Password"}
              >
                <Input
                  id="connection-password"
                  type="password"
                  autoComplete="off"
                  required={source === "keychain" && !(initial.secret === "keychain" && initial.id)}
                  value={password ?? ""}
                  placeholder={
                    source === "keychain"
                      ? initial.secret === "keychain" && initial.id
                        ? "Keep saved password"
                        : "Saved in OS keychain"
                      : "Not saved — for this session"
                  }
                  onChange={(event) => setPassword(event.target.value || undefined)}
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
                <Select
                  id="connection-encrypt"
                  value={options.encryption ?? (options.encrypt === false ? "off" : "on")}
                  onValueChange={(encryption) => option("encryption", encryption)}
                  items={[
                    { value: "on", label: "On" },
                    { value: "off", label: "Off" },
                    { value: "strict", label: "Strict" },
                  ]}
                />
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
              <Select
                id="connection-tls"
                value={profile.tls}
                onValueChange={(tls) => field("tls", tls)}
                items={[
                  { value: "prefer", label: "Prefer" },
                  { value: "disable", label: "Disable" },
                  { value: "require", label: "Require" },
                  { value: "verify-ca", label: "Verify CA" },
                  { value: "verify-full", label: "Verify full" },
                ]}
              />
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
                <Select
                  id="connection-role"
                  value={options.role ?? ""}
                  onValueChange={(role) => option("role", role || null)}
                  items={[
                    { value: "", label: "Default" },
                    { value: "SYSDBA", label: "SYSDBA" },
                    { value: "SYSOPER", label: "SYSOPER" },
                  ]}
                />
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
            <Select
              id="connection-color"
              value={profile.color ?? ""}
              onValueChange={(color) => field("color", color || null)}
              items={[
                { value: "", label: "Environment default" },
                { value: "blue", label: "Blue" },
                { value: "green", label: "Green" },
                { value: "amber", label: "Amber" },
                { value: "red", label: "Red" },
              ]}
            />
          </Field>
          <Field name="connection-agent" label="Agent access">
            <Select
              id="connection-agent"
              value={profile.agentAccess}
              onValueChange={(agentAccess) => field("agentAccess", agentAccess)}
              items={[
                { value: "none", label: "Disabled" },
                { value: "read", label: "Read" },
                {
                  value: "write",
                  label: "Read and write",
                  disabled: profile.env === "prod" || profile.readOnly,
                },
              ]}
            />
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
  canSave = !browserMode,
  onClose,
  onSubmit,
}: {
  name: string;
  canSave?: boolean;
  onClose: () => void;
  onSubmit: (password: string, saveToKeychain: boolean) => void;
}) {
  const [password, setPassword] = useState("");
  const [saveToKeychain, setSaveToKeychain] = useState(false);
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
          <DialogDescription>
            {saveToKeychain
              ? "Enter the database password to connect and save it in the OS keychain."
              : "Enter the database password for this session."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="connection-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(password, canSave && saveToKeychain);
          }}
        >
          <Field name="session-password" label="Password">
            <Input
              id="session-password"
              type="password"
              autoComplete="off"
              required={canSave && saveToKeychain}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          {canSave && (
            <Label className="read-only-field">
              <input
                type="checkbox"
                checked={saveToKeychain}
                onChange={(event) => setSaveToKeychain(event.target.checked)}
              />
              Save password in OS keychain
            </Label>
          )}
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
