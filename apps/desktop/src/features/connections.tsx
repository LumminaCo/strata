import { Database, FlaskConical, Link2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

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
import type { Connection } from "@/ipc/bindings/protocol";
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
  tls: "prefer",
  color: null,
  folder: null,
};

interface ConnectionDialogProps {
  initial: Connection;
  onSave: (profile: Connection, enteredPassword?: string) => void;
  onClose: () => void;
}

export function ConnectionDialog({ initial, onSave, onClose }: ConnectionDialogProps) {
  const [profile, setProfile] = useState(initial);
  const [password, setPassword] = useState<string>();
  const [url, setUrl] = useState("");
  const [envVariable, setEnvVariable] = useState(
    initial.secret.startsWith("env:") ? initial.secret.slice(4) : "",
  );
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean }>();
  const source = profile.secret.startsWith("env:") ? "env" : profile.secret;

  function field<K extends keyof Connection>(key: K, value: Connection[K]) {
    setProfile((current) => ({ ...current, [key]: value }));
    setFeedback(undefined);
  }

  function connection() {
    return { ...profile, secret: source === "env" ? `env:${envVariable.trim()}` : source };
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
          <DialogDescription>PostgreSQL</DialogDescription>
        </DialogHeader>
        <div className="url-row">
          <Input
            aria-label="Connection URL"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="postgresql://…"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <Button type="button" variant="outline" disabled={busy || !url.trim()} onClick={paste}>
            <Link2 /> Paste URL
          </Button>
        </div>
        {browserMode && import.meta.env.DEV && !initial.id && (
          <Button
            type="button"
            variant="ghost"
            className="fixture-button"
            disabled={busy}
            onClick={localFixture}
          >
            <Database /> Use local PostgreSQL
          </Button>
        )}
        <form onSubmit={save} className="connection-form">
          <fieldset disabled={busy} className="connection-fields">
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
            <Field name="connection-db" label="Database">
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
                required
                value={profile.user}
                onChange={(event) => field("user", event.target.value)}
              />
            </Field>
            <Field name="connection-secret" label="Authentication">
              <NativeSelect
                id="connection-secret"
                value={source}
                onChange={(event) => {
                  field("secret", event.target.value === "env" ? "env:" : event.target.value);
                  setPassword(undefined);
                }}
              >
                <NativeSelectOption value="prompt">Prompt for password</NativeSelectOption>
                {!browserMode && (
                  <NativeSelectOption value="keychain">OS keychain</NativeSelectOption>
                )}
                <NativeSelectOption value="env">Environment variable</NativeSelectOption>
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
            )}
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
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={test}>
              <FlaskConical /> Test connection
            </Button>
            <Button type="submit" disabled={busy}>
              Save connection
            </Button>
          </DialogFooter>
        </form>
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
