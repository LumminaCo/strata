import { useState } from "react";

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
import type { Settings } from "@/ipc/bindings/protocol";
import { dispatch, errorMessage } from "@/ipc/client";

const numbers = [
  { name: "fetch_size", label: "Initial fetch size", min: 1, max: 200_000 },
  { name: "row_cap", label: "Result row cap", min: 1, max: 200_000 },
  { name: "editor_font_size", label: "Editor font size (px)", min: 10, max: 32 },
  { name: "statement_timeout_ms", label: "Statement timeout (ms)", min: 0, max: 4_294_967_295 },
  { name: "agent_default_row_limit", label: "Agent default rows", min: 1, max: 10_000 },
  { name: "agent_max_row_limit", label: "Agent maximum rows", min: 1, max: 10_000 },
  { name: "agent_statement_timeout_s", label: "Agent timeout (s)", min: 1, max: 120 },
] as const;

const toggles = [
  { name: "blank_line_delimiter", label: "Use blank lines to select statements" },
  { name: "show_system_objects", label: "Show system objects" },
  { name: "confirm_production", label: "Confirm production statements that may write" },
] as const;

export function SettingsDialog({
  initial,
  onClose,
  onSave,
}: {
  initial: Settings;
  onClose: () => void;
  onSave: (value: Settings) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    try {
      await dispatch("settings_save", { settings: draft });
      onSave(draft);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="settings-dialog" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Query limits and statement timeouts apply to new sessions.
          </DialogDescription>
        </DialogHeader>
        <form
          className="connection-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset className="connection-fields" disabled={busy}>
            <div className="connection-field">
              <Label htmlFor="settings-theme">Theme</Label>
              <NativeSelect
                id="settings-theme"
                value={draft.theme}
                onChange={(event) =>
                  setDraft({ ...draft, theme: event.target.value as Settings["theme"] })
                }
              >
                <NativeSelectOption value="system">System</NativeSelectOption>
                <NativeSelectOption value="light">Light</NativeSelectOption>
                <NativeSelectOption value="dark">Dark</NativeSelectOption>
              </NativeSelect>
            </div>
            {numbers.map(({ name, label, min, max }) => (
              <div className="connection-field" key={name}>
                <Label htmlFor={`settings-${name}`}>{label}</Label>
                <Input
                  id={`settings-${name}`}
                  type="number"
                  required
                  min={min}
                  max={max}
                  value={draft[name]}
                  onChange={(event) => setDraft({ ...draft, [name]: event.target.valueAsNumber })}
                />
              </div>
            ))}
            {toggles.map(({ name, label }) => (
              <Label className="read-only-field" key={name}>
                <input
                  type="checkbox"
                  checked={draft[name]}
                  onChange={(event) => setDraft({ ...draft, [name]: event.target.checked })}
                />
                {label}
              </Label>
            ))}
          </fieldset>
          {error && (
            <p className="dialog-feedback" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              Save settings
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
