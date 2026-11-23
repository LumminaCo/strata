import { ArrowLeft, ArrowRight, ArrowUpRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { DatabaseIcon } from "@/components/database-icon";
import { Button } from "@/components/ui/button";
import type {
  CatalogScope,
  Cell,
  Definition,
  ObjectDetails,
  ObjectReference,
} from "@/ipc/bindings/protocol";
import { dispatch, errorMessage } from "@/ipc/client";

import type { CatalogEntry } from "./catalog-explorer";
import { TableData } from "./table-data";

export interface Inspection extends CatalogEntry {
  column?: string;
}
type Section = "Data" | "Columns" | "Keys & Indexes" | "References" | "DDL" | "Info";
const sections: Section[] = ["Data", "Columns", "Keys & Indexes", "References", "DDL", "Info"];

interface Props {
  subject: Inspection;
  theme: string;
  full?: boolean;
  credentials: (entry: CatalogEntry) => Promise<CatalogScope>;
  promote?: (entry: Inspection) => void;
  onValue: (name: string, value: Cell, kind?: string) => void;
}

export function TableInspector({ subject, theme, full, credentials, promote, onValue }: Props) {
  const [path, setPath] = useState({ items: [subject], index: 0 });
  const current = path.items[path.index] ?? subject;
  const table = ["table", "view", "materialized_view", "foreign_table"].includes(
    current.object.kind,
  );
  const [section, setSection] = useState<Section>(
    table ? (subject.column ? "Columns" : "Data") : "DDL",
  );
  const [details, setDetails] = useState<ObjectDetails>();
  const [error, setError] = useState("");
  const controls = useRef(credentials);
  controls.current = credentials;
  const column = useRef<HTMLTableRowElement>(null);

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
        return (
          <div className="object-details">
            <pre tabIndex={0}>{details.ddl}</pre>
            <Button
              variant="outline"
              onClick={() =>
                void navigator.clipboard
                  .writeText(details.ddl)
                  .catch((error: unknown) => setError(errorMessage(error)))
              }
            >
              Copy DDL
            </Button>
          </div>
        );
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
