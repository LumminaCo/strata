import { Database, Layers } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { DatabaseIcon } from "@/components/database-icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { errorMessage } from "@/ipc/client";

import type { CatalogEntry } from "./catalog-explorer";

export function CatalogPalette({
  entries,
  onClose,
  onOpen,
  onHistory,
}: {
  entries: CatalogEntry[];
  onClose: () => void;
  onOpen: (entry: CatalogEntry) => void;
  onHistory: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matches = entries
    .map((entry) => ({
      entry,
      score: fuzzyScore(
        `${entry.object.schema}.${entry.object.name} ${entry.connection.name}`,
        query,
      ),
    }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => a.score - b.score)
    .slice(0, 100);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="catalog-dialog">
        <DialogHeader>
          <DialogTitle>Quick open</DialogTitle>
          <DialogDescription>Search loaded database objects.</DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Search database objects"
          value={query}
          placeholder="Schema or object name"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive((current) =>
                Math.max(
                  0,
                  Math.min(matches.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)),
                ),
              );
            }
            if (event.key === "Enter") {
              const item = matches[active];
              if (item) onOpen(item.entry);
            }
          }}
        />
        <div className="catalog-dialog-list" aria-label="Matching objects">
          {!matches.length && <p>No matching objects. Expand a schema to load its objects.</p>}
          {matches.map(({ entry }, index) => (
            <Button
              key={JSON.stringify([
                entry.connection.id,
                entry.database,
                entry.object.oid,
                entry.object.name,
              ])}
              variant="ghost"
              data-active={index === active}
              onClick={() => onOpen(entry)}
            >
              <DatabaseIcon kind={entry.connection.kind} />
              <span>
                {entry.object.schema}.{entry.object.name}
              </span>
              <small>
                {entry.connection.name} · {entry.database}
              </small>
            </Button>
          ))}
        </div>
        <Button variant="outline" onClick={onHistory}>
          Query history
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function fuzzyScore(value: string, query: string) {
  const haystack = value.toLocaleLowerCase();
  const needle = query.trim().toLocaleLowerCase();
  const substring = haystack.indexOf(needle);
  if (substring >= 0) return substring;
  let end = 0;
  for (const char of needle) {
    end = haystack.indexOf(char, end) + 1;
    if (!end) return -1;
  }
  return haystack.length + end;
}

export function DatabasePicker({
  selected,
  load,
  onChange,
  disabled,
}: {
  selected: string;
  load: () => Promise<string[]>;
  onChange: (database: string) => void;
  disabled: boolean;
}) {
  const [databases, setDatabases] = useState<string[]>();
  const [error, setError] = useState("");
  return (
    <div className="toolbar-picker">
      <Database aria-hidden="true" />
      <NativeSelect
        aria-label="Tab database"
        size="sm"
        value={selected}
        disabled={disabled}
        title={error || "Change database for this tab"}
        onFocus={() => {
          if (!databases)
            void load().then(setDatabases, (error: unknown) => setError(errorMessage(error)));
        }}
        onChange={(event) => onChange(event.target.value)}
      >
        {[...new Set([selected, ...(databases ?? [])])].map((database) => (
          <NativeSelectOption key={database} value={database}>
            {database}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}

export function SchemaPicker({
  selected,
  load,
  onChange,
  disabled,
}: {
  selected: string;
  load: () => Promise<string[]>;
  onChange: (schema: string) => void;
  disabled: boolean;
}) {
  const [schemas, setSchemas] = useState<string[]>();
  const [error, setError] = useState("");
  const loading = useRef(false);
  const latest = useRef(load);
  latest.current = load;

  function fetchSchemas() {
    if (loading.current) return;
    loading.current = true;
    void latest
      .current()
      .then(
        (items) => {
          setSchemas(items);
          setError("");
        },
        (err: unknown) => setError(errorMessage(err)),
      )
      .finally(() => {
        loading.current = false;
      });
  }

  useEffect(() => {
    let current = true;
    loading.current = true;
    void latest
      .current()
      .then(
        (items) => {
          if (current) {
            setSchemas(items);
            setError("");
          }
        },
        (err: unknown) => {
          if (current) setError(errorMessage(err));
        },
      )
      .finally(() => {
        if (current) loading.current = false;
      });
    return () => {
      current = false;
      loading.current = false;
    };
  }, []);

  const options = [...new Set([selected, ...(schemas ?? [])].filter(Boolean))];
  return (
    <div className="toolbar-picker">
      <Layers aria-hidden="true" />
      <NativeSelect
        aria-label="Default schema"
        size="sm"
        value={selected}
        disabled={disabled}
        title={error || "Change default schema for this tab"}
        onFocus={() => {
          if (!schemas) fetchSchemas();
        }}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((schema) => (
          <NativeSelectOption key={schema} value={schema}>
            {schema}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}
