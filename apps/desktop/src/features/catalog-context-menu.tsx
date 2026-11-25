import {
  ChevronDown,
  ChevronRight,
  Code2,
  Columns3,
  Copy,
  CornerDownLeft,
  FileCode2,
  FileText,
  Info,
  KeyRound,
  Link2,
  PanelBottom,
  RefreshCw,
  Settings2,
  Table2,
  Trash2,
} from "lucide-react";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { Connection, Object as CatalogObject } from "@/ipc/bindings/protocol";

import type { CatalogEntry } from "./catalog-explorer";
import { quoteName } from "./table-data";
import type { Inspection } from "./table-inspector";

export type CatalogNodeKind = "folder" | "connection" | "database" | "schema" | "group" | "object";

export interface CatalogNode {
  key: string;
  kind: CatalogNodeKind;
  label: string;
  connection: Connection;
  database: string;
  schema?: string;
  children?: CatalogNode[];
  object?: CatalogObject;
  columns?: string[];
}

export function isRelationObject(kind: CatalogObject["kind"]): boolean {
  return (
    kind === "table" || kind === "view" || kind === "materialized_view" || kind === "foreign_table"
  );
}

export function formatQualifiedObjectName(
  schema: string,
  name: string,
  kind: Connection["kind"],
): string {
  return [schema, name].map((part) => quoteName(part, kind)).join(".");
}

export function buildSelectQuery(entry: CatalogEntry, columns?: string[], limit = 100): string {
  const kind = entry.connection.kind;
  const target = formatQualifiedObjectName(entry.object.schema, entry.object.name, kind);
  const quotedColumns =
    columns && columns.length > 0
      ? columns.map((column) => `  ${quoteName(column, kind)}`).join(",\n")
      : null;

  if (kind === "sqlserver") {
    return quotedColumns
      ? `SELECT TOP (${limit})\n${quotedColumns}\nFROM ${target};`
      : `SELECT TOP (${limit}) *\nFROM ${target};`;
  }

  const selectClause = quotedColumns ? `SELECT\n${quotedColumns}` : "SELECT *";
  if (kind === "oracle") {
    return `${selectClause}\nFROM ${target}\nWHERE ROWNUM <= ${limit};`;
  }
  return `${selectClause}\nFROM ${target}\nLIMIT ${limit};`;
}

export interface CatalogRowMenuProps {
  node: CatalogNode;
  depth: number;
  branch: boolean;
  opened: boolean;
  filtered: boolean;
  active: boolean;
  canPin: boolean;
  canInsertInEditor: boolean;
  style: CSSProperties;
  children: ReactNode;
  onToggle: () => void;
  onRefresh: () => void;
  onNewSqlTab: () => void;
  onInspectObject?: (entry: Inspection) => void;
  onPinObject?: (entry: Inspection) => void;
  onGenerateSelect?: (entry: CatalogEntry, sql: string) => void;
  onInsertText?: (text: string) => void;
  onCopyText?: (text: string, label: string) => void;
  onCopyDdl?: (entry: CatalogEntry) => void;
  onEditConnection?: (connection: Connection) => void;
  onDuplicateConnection?: (connection: Connection) => void;
  onDeleteConnection?: (connection: Connection) => void;
}

export function CatalogRowMenu({
  node,
  depth,
  branch,
  opened,
  filtered,
  active,
  canPin,
  canInsertInEditor,
  style,
  children,
  onToggle,
  onRefresh,
  onNewSqlTab,
  onInspectObject,
  onPinObject,
  onGenerateSelect,
  onInsertText,
  onCopyText,
  onCopyDdl,
  onEditConnection,
  onDuplicateConnection,
  onDeleteConnection,
}: CatalogRowMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const skipFinalFocusRef = useRef(false);

  function leaveFocus(action: () => void) {
    skipFinalFocusRef.current = true;
    action();
  }

  function renderMenuItems() {
    switch (node.kind) {
      case "folder":
        return (
          <ContextMenuItem disabled={filtered} onClick={onToggle}>
            {opened ? <ChevronDown /> : <ChevronRight />}
            {opened ? "Collapse" : "Expand"}
          </ContextMenuItem>
        );

      case "connection":
        return (
          <>
            <ContextMenuItem onClick={() => leaveFocus(onNewSqlTab)}>
              <FileCode2 />
              New SQL tab
            </ContextMenuItem>
            <ContextMenuItem disabled={filtered} onClick={onToggle}>
              {opened ? <ChevronDown /> : <ChevronRight />}
              {opened ? "Collapse" : "Expand"}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              disabled={!onEditConnection}
              onClick={() => leaveFocus(() => onEditConnection?.(node.connection))}
            >
              <Settings2 />
              Edit connection
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!onDuplicateConnection}
              onClick={() => leaveFocus(() => onDuplicateConnection?.(node.connection))}
            >
              <Copy />
              Duplicate connection
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onRefresh}>
              <RefreshCw />
              Refresh
              <ContextMenuShortcut>F5</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              disabled={!onDeleteConnection}
              onClick={() => leaveFocus(() => onDeleteConnection?.(node.connection))}
            >
              <Trash2 />
              Delete connection
            </ContextMenuItem>
          </>
        );

      case "database":
        return (
          <>
            <ContextMenuItem onClick={() => leaveFocus(onNewSqlTab)}>
              <FileCode2 />
              New SQL tab
            </ContextMenuItem>
            <ContextMenuItem disabled={filtered} onClick={onToggle}>
              {opened ? <ChevronDown /> : <ChevronRight />}
              {opened ? "Collapse" : "Expand"}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onCopyText?.(node.database, node.database)}>
              <Copy />
              Copy name
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onRefresh}>
              <RefreshCw />
              Refresh
              <ContextMenuShortcut>F5</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        );

      case "schema": {
        const schemaName = node.schema ?? node.label;
        const quotedSchema = quoteName(schemaName, node.connection.kind);
        return (
          <>
            <ContextMenuItem disabled={filtered} onClick={onToggle}>
              {opened ? <ChevronDown /> : <ChevronRight />}
              {opened ? "Collapse" : "Expand"}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => leaveFocus(onNewSqlTab)}>
              <FileCode2 />
              New SQL tab
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              disabled={!canInsertInEditor || !onInsertText}
              onClick={() => leaveFocus(() => onInsertText?.(quotedSchema))}
            >
              <CornerDownLeft />
              Insert name in editor
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onCopyText?.(schemaName, schemaName)}>
              <Copy />
              Copy name
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onRefresh}>
              <RefreshCw />
              Refresh
              <ContextMenuShortcut>F5</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        );
      }

      case "group":
        return (
          <>
            <ContextMenuItem disabled={filtered} onClick={onToggle}>
              {opened ? <ChevronDown /> : <ChevronRight />}
              {opened ? "Collapse" : "Expand"}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => leaveFocus(onNewSqlTab)}>
              <FileCode2 />
              New SQL tab
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onRefresh}>
              <RefreshCw />
              Refresh
              <ContextMenuShortcut>F5</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        );

      case "object": {
        const object = node.object;
        if (!object) return null;
        const entry: CatalogEntry = {
          connection: node.connection,
          database: node.database,
          object,
        };
        const relation = isRelationObject(object.kind);
        const qualifiedName = formatQualifiedObjectName(
          object.schema,
          object.name,
          node.connection.kind,
        );

        return (
          <>
            {relation ? (
              <>
                <ContextMenuItem
                  onClick={() => leaveFocus(() => onInspectObject?.({ ...entry, section: "Data" }))}
                >
                  <Table2 />
                  Open data
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() =>
                    leaveFocus(() => onInspectObject?.({ ...entry, section: "Columns" }))
                  }
                >
                  <Columns3 />
                  View columns
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() =>
                    leaveFocus(() => onInspectObject?.({ ...entry, section: "Keys & Indexes" }))
                  }
                >
                  <KeyRound />
                  Keys &amp; indexes
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() =>
                    leaveFocus(() => onInspectObject?.({ ...entry, section: "References" }))
                  }
                >
                  <Link2 />
                  References
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => leaveFocus(() => onInspectObject?.({ ...entry, section: "DDL" }))}
                >
                  <FileCode2 />
                  View DDL
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => leaveFocus(() => onInspectObject?.({ ...entry, section: "Info" }))}
                >
                  <Info />
                  Object info
                </ContextMenuItem>
              </>
            ) : (
              <>
                <ContextMenuItem
                  onClick={() => leaveFocus(() => onInspectObject?.({ ...entry, section: "DDL" }))}
                >
                  <FileCode2 />
                  View DDL
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => leaveFocus(() => onInspectObject?.({ ...entry, section: "Info" }))}
                >
                  <Info />
                  Object info
                </ContextMenuItem>
              </>
            )}
            <ContextMenuItem
              disabled={!canPin || !onPinObject}
              onClick={() =>
                leaveFocus(() => onPinObject?.({ ...entry, section: relation ? "Data" : "DDL" }))
              }
            >
              <PanelBottom />
              Pin to results panel
            </ContextMenuItem>
            <ContextMenuSeparator />
            {relation && (
              <ContextMenuItem
                disabled={!onGenerateSelect}
                onClick={() =>
                  leaveFocus(() => onGenerateSelect?.(entry, buildSelectQuery(entry, node.columns)))
                }
              >
                <Code2 />
                Generate SELECT
              </ContextMenuItem>
            )}
            <ContextMenuItem
              disabled={!canInsertInEditor || !onInsertText}
              onClick={() => leaveFocus(() => onInsertText?.(qualifiedName))}
            >
              <CornerDownLeft />
              Insert name in editor
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onCopyText?.(object.name, object.name)}>
              <Copy />
              Copy name
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onCopyText?.(qualifiedName, qualifiedName)}>
              <Copy />
              Copy qualified name
            </ContextMenuItem>
            <ContextMenuItem disabled={!onCopyDdl} onClick={() => onCopyDdl?.(entry)}>
              <FileText />
              Copy DDL
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onRefresh}>
              <RefreshCw />
              Refresh
              <ContextMenuShortcut>F5</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        );
      }
    }
  }

  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger
        className="catalog-row"
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={branch ? opened : undefined}
        aria-selected={node.kind === "connection" ? active : undefined}
        data-active={active}
        data-context-open={menuOpen ? "true" : undefined}
        style={style}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        finalFocus={() => {
          if (skipFinalFocusRef.current) {
            skipFinalFocusRef.current = false;
            return false;
          }
          return true;
        }}
      >
        {renderMenuItems()}
      </ContextMenuContent>
    </ContextMenu>
  );
}
