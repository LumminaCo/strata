import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { DatabaseIcon } from "@/components/database-icon";
import { Button } from "@/components/ui/button";
import type {
  CatalogScope,
  Cell,
  Definition,
  ForeignKeyRef,
  ObjectDetails,
  ObjectKind,
  ObjectReference,
} from "@/ipc/bindings/protocol";
import { dispatch, errorMessage } from "@/ipc/client";

import { isRelationObject } from "./catalog-context-menu";
import type { CatalogEntry } from "./catalog-explorer";
import { TableData } from "./table-data";

export type InspectionSection =
  | "Data"
  | "Columns"
  | "Keys & Indexes"
  | "References"
  | "DDL"
  | "Info";

export interface Inspection extends CatalogEntry {
  column?: string;
  section?: InspectionSection;
  requestId?: number;
}

const sections: InspectionSection[] = [
  "Data",
  "Columns",
  "Keys & Indexes",
  "References",
  "DDL",
  "Info",
];

export function resolveInspectionSection(subject: Inspection): InspectionSection {
  const relation = isRelationObject(subject.object.kind);
  if (subject.section) {
    if (relation || subject.section === "DDL" || subject.section === "Info") {
      return subject.section;
    }
  }
  return relation ? (subject.column ? "Columns" : "Data") : "DDL";
}

export function resolveNavigationTarget(kind: ObjectKind, full: boolean): "tab" | "pinned" {
  if (full || kind === "function" || kind === "procedure") return "tab";
  return "pinned";
}

interface Props {
  subject: Inspection;
  theme: string;
  full?: boolean;
  credentials: (entry: CatalogEntry) => Promise<CatalogScope>;
  promote?: (entry: Inspection) => void;
  onValue: (name: string, value: Cell, kind?: string) => void;
  onFollowForeignKey?: (options: {
    entry: CatalogEntry;
    target: ForeignKeyRef;
    value: Cell;
    columnKind?: string;
  }) => void;
}

export function TableInspector({
  subject,
  theme,
  full,
  credentials,
  promote,
  onValue,
  onFollowForeignKey,
}: Props) {
  const [path, setPath] = useState({ items: [subject], index: 0 });
  const current = path.items[path.index] ?? subject;
  const table = isRelationObject(current.object.kind);
  const [section, setSection] = useState<InspectionSection>(() =>
    resolveInspectionSection(subject),
  );
  const appliedRequest = useRef(subject.requestId);
  const [details, setDetails] = useState<ObjectDetails>();
  const [error, setError] = useState("");
  const controls = useRef(credentials);
  controls.current = credentials;
  const column = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    if (subject.requestId === appliedRequest.current) return;
    appliedRequest.current = subject.requestId;
    setPath({ items: [subject], index: 0 });
    setSection(resolveInspectionSection(subject));
  }, [subject]);

  useEffect(() => {
    let visible = true;
    setDetails(undefined);
    setError("");
    void controls
      .current(current)
      .then((scope) => dispatch("object_details", { scope, object: current.object }))
      .then(
        (value) => {
          if (visible) setDetails(value);
        },
        (error: unknown) => {
          if (visible) setError(errorMessage(error));
        },
      );
    return () => {
      visible = false;
    };
  }, [current]);

  useEffect(() => {
    column.current?.scrollIntoView({ block: "nearest" });
  }, [details, section]);

  function move(amount: number) {
    setPath((path) => ({
      ...path,
      index: Math.max(0, Math.min(path.items.length - 1, path.index + amount)),
    }));
  }

  async function follow(reference: ObjectReference) {
    try {
      const scope = await controls.current(current);
      const object = await dispatch("resolve_object", { scope, reference });
      if (!object) throw new Error(`Could not find ${reference.schema}.${reference.name}.`);
      setPath((path) => ({
        items: [...path.items.slice(0, path.index + 1), { ...current, object, column: undefined }],
        index: path.index + 1,
      }));
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  const name = `${current.object.schema}.${current.object.name}`;
  const info = details?.detail;
  const foreign = info?.constraints.filter((entry) => !!entry.related) ?? [];
  const incoming = info?.referenced_by ?? [];
  const content = (() => {
    if (section === "Data" && table)
      return (
        <TableData
          key={`${current.database}:${current.object.oid}`}
          entry={current}
          theme={theme}
          credentials={() => controls.current(current)}
          onValue={onValue}
          onFollowForeignKey={onFollowForeignKey}
        />
      );
    if (error)
      return (
        <p className="table-error" role="alert">
          {error}
        </p>
      );
    if (!details) return <div className="results-empty">Loading object details…</div>;
    switch (section) {
      case "Columns":
        return (
          <table className="object-columns">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Nullable</th>
                <th>Default</th>
                <th>Comment</th>
              </tr>
            </thead>
            <tbody>
              {info?.columns.map((item) => (
                <tr
                  key={item.name}
                  data-active={current.column === item.name}
                  ref={current.column === item.name ? column : undefined}
                >
                  <th>{item.name}</th>
                  <td>{item.db_type}</td>
                  <td>{item.nullable ? "Yes" : "No"}</td>
                  <td>{item.default}</td>
                  <td>{item.comment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      case "Keys & Indexes":
        return (
          <div className="object-details">
            <Definitions title="Constraints" rows={info?.constraints ?? []} follow={follow} />
            <Definitions title="Indexes" rows={info?.indexes ?? []} follow={follow} />
          </div>
        );
      case "References":
        return (
          <div className="object-details">
            <Definitions title="Outgoing" rows={foreign} follow={follow} />
            <Definitions title="Incoming" rows={incoming} follow={follow} />
          </div>
        );
      case "DDL":
        return <ObjectDdlView ddl={details.ddl} onError={setError} />;
      case "Info":
        return (
          <dl className="object-info">
            <dt>Connection</dt>
            <dd>{current.connection.name}</dd>
            <dt>Database</dt>
            <dd>{current.database}</dd>
            <dt>Object</dt>
            <dd>{name}</dd>
            <dt>Kind</dt>
            <dd>{current.object.kind.replaceAll("_", " ")}</dd>
            {current.object.rows !== null && (
              <>
                <dt>Estimated rows</dt>
                <dd>{current.object.rows}</dd>
              </>
            )}
            {info && (
              <>
                <dt>Size</dt>
                <dd>{info.size_bytes.toLocaleString()} bytes</dd>
              </>
            )}
            {current.object.comment && (
              <>
                <dt>Comment</dt>
                <dd>{current.object.comment}</dd>
              </>
            )}
          </dl>
        );
      case "Data":
        return null;
    }
  })();

  return (
    <div
      className="table-inspector"
      data-full={!!full}
      onKeyDown={(event) => {
        if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          event.stopPropagation();
          event.preventDefault();
          move(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <header className="table-inspector-header">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Previous table"
          disabled={path.index === 0}
          onClick={() => move(-1)}
        >
          <ArrowLeft />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Next table"
          disabled={path.index + 1 >= path.items.length}
          onClick={() => move(1)}
        >
          <ArrowRight />
        </Button>
        <DatabaseIcon kind={current.connection.kind} />
        <strong>{name}</strong>
        {promote && (
          <Button size="xs" variant="ghost" onClick={() => promote(current)}>
            <ArrowUpRight /> Open as tab
          </Button>
        )}
      </header>
      <div className="table-inspector-tabs" role="tablist" aria-label="Table sections">
        {(table ? sections : (["DDL", "Info"] as const)).map((item) => (
          <Button
            role="tab"
            aria-selected={section === item}
            key={item}
            variant="ghost"
            size="xs"
            onClick={() => setSection(item)}
          >
            {item}
          </Button>
        ))}
      </div>
      <div className="table-inspector-body">
        {full && (foreign.length > 0 || incoming.length > 0) && (
          <aside className="related-tables" aria-label="Related tables">
            {[...foreign, ...incoming].map(
              (entry, index) =>
                entry.related && (
                  <Button
                    variant="ghost"
                    key={`${entry.name}-${index}`}
                    title={entry.name}
                    onClick={() => {
                      if (entry.related) void follow(entry.related);
                    }}
                  >
                    {entry.related.schema}.{entry.related.name}
                  </Button>
                ),
            )}
          </aside>
        )}
        <div className="table-inspector-content">{content}</div>
      </div>
    </div>
  );
}

export function ObjectDdlView({
  ddl,
  onError,
}: {
  ddl: string;
  onError: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setCopied(false);
    clearTimeout(timer.current);
    return () => clearTimeout(timer.current);
  }, [ddl]);

  function copy() {
    void navigator.clipboard.writeText(ddl).then(
      () => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2000);
      },
      (error: unknown) => onError(errorMessage(error)),
    );
  }

  return (
    <div className="object-details object-ddl">
      <div className="object-ddl-actions">
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="object-ddl-copy"
          onClick={copy}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copied" : "Copy DDL"}
        </Button>
      </div>
      <pre tabIndex={0}>{ddl}</pre>
    </div>
  );
}

function Definitions({
  title,
  rows,
  follow,
}: {
  title: string;
  rows: Definition[];
  follow: (ref: ObjectReference) => Promise<void>;
}) {
  return (
    <section>
      <h3>{title}</h3>
      {!rows.length && <p>No entries</p>}
      {rows.map((row) => (
        <article key={row.name}>
          <strong>{row.name}</strong>
          <pre>{row.sql}</pre>
          {row.related && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                if (row.related) void follow(row.related);
              }}
            >
              {row.related.schema}.{row.related.name}
            </Button>
          )}
        </article>
      ))}
    </section>
  );
}
