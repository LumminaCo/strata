import {
  ArrowLeft,
  ArrowRight,
  Copy,
  FileCode2,
  Maximize2,
  Pencil,
  RotateCcw,
  X,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { DatabaseIcon } from "@/components/database-icon";
import type { ResultSet } from "@/components/result-grid";
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
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { MAX_TAB_TITLE_LENGTH } from "@/features/tab-order";
import type { Inspection } from "@/features/table-inspector";
import type { TabDragBindings } from "@/features/use-tab-drag";
import type { Connection, SavedTab } from "@/ipc/bindings/protocol";

export type { TabDragBindings };

export interface MiddleClickEventLike {
  button: number;
  defaultPrevented?: boolean;
  target: EventTarget | null;
  preventDefault: () => void;
  stopPropagation?: () => void;
}

export interface MiddleClickCloseBindings {
  onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
  onMouseUp: (event: ReactMouseEvent<HTMLElement>) => void;
  onMouseLeave: () => void;
  onAuxClick: (event: ReactMouseEvent<HTMLElement>) => void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  return Boolean(element?.closest?.("input, textarea, [contenteditable='true']"));
}

export function createMiddleClickCloseController(options: {
  getDisabled: () => boolean;
  onClose: () => void;
}) {
  let middlePressed = false;
  let handledByMouseUp = false;

  return {
    onMouseDown(event: MiddleClickEventLike) {
      if (event.button !== 1 || isEditableTarget(event.target)) return;
      const alreadyPrevented = Boolean(event.defaultPrevented);
      event.preventDefault();
      if (options.getDisabled() || alreadyPrevented) {
        middlePressed = false;
        return;
      }
      middlePressed = true;
      handledByMouseUp = false;
    },
    onMouseUp(event: MiddleClickEventLike) {
      if (event.button !== 1 || !middlePressed) return;
      middlePressed = false;
      if (options.getDisabled() || isEditableTarget(event.target)) return;
      handledByMouseUp = true;
      event.preventDefault();
      event.stopPropagation?.();
      options.onClose();
    },
    onMouseLeave() {
      middlePressed = false;
    },
    onAuxClick(event: MiddleClickEventLike) {
      if (event.button !== 1 || isEditableTarget(event.target)) return;
      event.preventDefault();
      if (handledByMouseUp) {
        handledByMouseUp = false;
        return;
      }
      if (options.getDisabled()) return;
      event.stopPropagation?.();
      options.onClose();
    },
  };
}

function useMiddleClickClose(onClose: () => void, disabled = false): MiddleClickCloseBindings {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const controllerRef = useRef<ReturnType<typeof createMiddleClickCloseController> | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createMiddleClickCloseController({
      getDisabled: () => disabledRef.current,
      onClose: () => onCloseRef.current(),
    });
  }

  return {
    onMouseDown: (event) => controllerRef.current?.onMouseDown(event),
    onMouseUp: (event) => controllerRef.current?.onMouseUp(event),
    onMouseLeave: () => controllerRef.current?.onMouseLeave(),
    onAuxClick: (event) => controllerRef.current?.onAuxClick(event),
  };
}

export function describeUnsavedClosePrompt(labels: readonly string[]): {
  title: string;
  description: string;
  saveLabel: string;
} {
  if (labels.length <= 1) {
    const label = labels[0] ?? "SQL tab";
    return {
      title: `Save changes to ${label}?`,
      description: "This SQL tab has unsaved changes. Save it before closing?",
      saveLabel: "Save",
    };
  }
  const preview =
    labels.length <= 3
      ? labels.join(", ")
      : `${labels.slice(0, 2).join(", ")} and ${labels.length - 2} more`;
  return {
    title: `Save changes to ${labels.length} SQL tabs?`,
    description: `These SQL tabs have unsaved changes (${preview}). Save them before closing?`,
    saveLabel: "Save all",
  };
}

export interface UnsavedTabCloseDialogProps {
  labels: readonly string[];
  saving?: boolean;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}

export function UnsavedTabCloseDialog({
  labels,
  saving = false,
  onCancel,
  onDiscard,
  onSave,
}: UnsavedTabCloseDialogProps) {
  const copy = describeUnsavedClosePrompt(labels);

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={saving} onClick={onDiscard}>
            Don&apos;t save
          </AlertDialogAction>
          <AlertDialogAction disabled={saving} onClick={onSave}>
            {saving ? "Saving…" : copy.saveLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface InlineTabRenameProps {
  initialValue: string;
  placeholder: string;
  ariaLabel: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

export function InlineTabRename({
  initialValue,
  placeholder,
  ariaLabel,
  onCommit,
  onCancel,
}: InlineTabRenameProps) {
  const [draft, setDraft] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.scrollIntoView({ block: "nearest", inline: "nearest" });
    input.focus();
    input.select();
  }, []);

  function commit() {
    if (settledRef.current) return;
    settledRef.current = true;
    onCommit(draft);
  }

  function cancel() {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  }

  return (
    <input
      ref={inputRef}
      type="text"
      className="tab-rename-input"
      data-no-drag="true"
      aria-label={ariaLabel}
      placeholder={placeholder}
      maxLength={MAX_TAB_TITLE_LENGTH}
      size={Math.max(8, Math.min(28, (draft || placeholder).length + 1))}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    />
  );
}

export interface ScriptTabItemProps {
  tab: SavedTab;
  connection?: Connection;
  label: string;
  defaultLabel: string;
  active: boolean;
  unsaved?: boolean;
  renaming: boolean;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  canCloseOthers: boolean;
  canCloseRight: boolean;
  closeShortcut: string;
  dragProps: TabDragBindings;
  onSelect: () => void;
  onStartRename: () => void;
  onCommitRename: (value: string) => void;
  onCancelRename: () => void;
  onResetName: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  onDuplicate: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseRight: () => void;
}

export function ScriptTabItem({
  tab,
  connection,
  label,
  defaultLabel,
  active,
  unsaved = false,
  renaming,
  canMoveLeft,
  canMoveRight,
  canCloseOthers,
  canCloseRight,
  closeShortcut,
  dragProps,
  onSelect,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onResetName,
  onMoveLeft,
  onMoveRight,
  onDuplicate,
  onClose,
  onCloseOthers,
  onCloseRight,
}: ScriptTabItemProps) {
  const skipFinalFocusRef = useRef(false);
  const middleClickClose = useMiddleClickClose(onClose, renaming);
  const baseTitle = tab.title ? `${label} (${defaultLabel})` : label;
  const withPath = tab.filePath ? `${baseTitle} · ${tab.filePath}` : baseTitle;
  const title = unsaved ? `${withPath} · Unsaved` : withPath;

  return (
    <ContextMenu>
      <ContextMenuTrigger
        className="query-tab"
        data-active={active}
        data-renaming={renaming ? "true" : undefined}
        data-unsaved={unsaved ? "true" : undefined}
        {...dragProps}
        {...middleClickClose}
      >
        {renaming ? (
          <div className="query-tab-rename" role="tab" aria-selected={active}>
            {unsaved && <span className="unsaved-dot" aria-hidden="true" />}
            {connection ? <DatabaseIcon kind={connection.kind} /> : <FileCode2 />}
            <InlineTabRename
              initialValue={tab.title ?? label}
              placeholder={defaultLabel}
              ariaLabel={`Rename ${label}`}
              onCommit={onCommitRename}
              onCancel={onCancelRename}
            />
            <span className="env-dot" data-env={connection?.env} data-color={connection?.color} />
          </div>
        ) : (
          <Button
            variant="ghost"
            role="tab"
            aria-selected={active}
            title={title}
            onClick={onSelect}
            onDoubleClick={(event) => {
              event.preventDefault();
              onStartRename();
            }}
            onKeyDown={(event) => {
              if (event.key === "F2") {
                event.preventDefault();
                onStartRename();
              }
            }}
          >
            {unsaved && <span className="unsaved-dot" aria-hidden="true" />}
            {connection ? <DatabaseIcon kind={connection.kind} /> : <FileCode2 />}
            <span className="tab-label">{label}</span>
            {unsaved && <span className="sr-only"> (unsaved)</span>}
            <span className="env-dot" data-env={connection?.env} data-color={connection?.color} />
          </Button>
        )}
        <Button
          data-no-drag="true"
          variant="ghost"
          size="icon-xs"
          aria-label={`Close ${label}`}
          title={`Close tab (${closeShortcut})`}
          onClick={onClose}
        >
          <X />
        </Button>
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
        <ContextMenuItem
          onClick={() => {
            skipFinalFocusRef.current = true;
            onStartRename();
          }}
        >
          <Pencil />
          Rename
          <ContextMenuShortcut>F2</ContextMenuShortcut>
        </ContextMenuItem>
        {tab.title && (
          <ContextMenuItem onClick={onResetName}>
            <RotateCcw />
            Reset name
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!canMoveLeft} onClick={onMoveLeft}>
          <ArrowLeft />
          Move left
        </ContextMenuItem>
        <ContextMenuItem disabled={!canMoveRight} onClick={onMoveRight}>
          <ArrowRight />
          Move right
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onDuplicate}>
          <Copy />
          Duplicate
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onClose}>
          <X />
          Close
          <ContextMenuShortcut>{closeShortcut}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!canCloseOthers} onClick={onCloseOthers}>
          Close others
        </ContextMenuItem>
        <ContextMenuItem disabled={!canCloseRight} onClick={onCloseRight}>
          Close to the right
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export interface SchemaTabItemProps {
  item: Inspection;
  active: boolean;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  canCloseOthers: boolean;
  dragProps: TabDragBindings;
  onSelect: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
}

export function SchemaTabItem({
  item,
  active,
  canMoveLeft,
  canMoveRight,
  canCloseOthers,
  dragProps,
  onSelect,
  onMoveLeft,
  onMoveRight,
  onClose,
  onCloseOthers,
}: SchemaTabItemProps) {
  const label = `${item.object.schema}.${item.object.name}`;
  const middleClickClose = useMiddleClickClose(onClose);

  return (
    <ContextMenu>
      <ContextMenuTrigger
        className="query-tab"
        data-active={active}
        {...dragProps}
        {...middleClickClose}
      >
        <Button variant="ghost" role="tab" aria-selected={active} title={label} onClick={onSelect}>
          <DatabaseIcon kind={item.connection.kind} />
          <span className="tab-label">{label}</span>
        </Button>
        <Button
          data-no-drag="true"
          variant="ghost"
          size="icon-xs"
          aria-label={`Close schema tab ${item.object.name}`}
          onClick={onClose}
        >
          <X />
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!canMoveLeft} onClick={onMoveLeft}>
          <ArrowLeft />
          Move left
        </ContextMenuItem>
        <ContextMenuItem disabled={!canMoveRight} onClick={onMoveRight}>
          <ArrowRight />
          Move right
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onClose}>
          <X />
          Close
        </ContextMenuItem>
        <ContextMenuItem disabled={!canCloseOthers} onClick={onCloseOthers}>
          Close others
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export interface ResultTabItemProps {
  result: ResultSet;
  label: string;
  defaultLabel: string;
  active: boolean;
  renaming: boolean;
  fetching: boolean;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  canCloseOthers: boolean;
  dragProps: TabDragBindings;
  onSelect: () => void;
  onStartRename: () => void;
  onCommitRename: (value: string) => void;
  onCancelRename: () => void;
  onResetName: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
}

export function ResultTabItem({
  result,
  label,
  defaultLabel,
  active,
  renaming,
  fetching,
  canMoveLeft,
  canMoveRight,
  canCloseOthers,
  dragProps,
  onSelect,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onResetName,
  onMoveLeft,
  onMoveRight,
  onClose,
  onCloseOthers,
}: ResultTabItemProps) {
  const skipFinalFocusRef = useRef(false);
  const middleClickClose = useMiddleClickClose(onClose, renaming || fetching);

  return (
    <ContextMenu>
      <ContextMenuTrigger
        className="result-tab"
        data-active={active}
        data-renaming={renaming ? "true" : undefined}
        {...dragProps}
        {...middleClickClose}
      >
        {renaming ? (
          <div className="result-tab-rename" role="tab" aria-selected={active}>
            <InlineTabRename
              initialValue={result.title ?? label}
              placeholder={defaultLabel}
              ariaLabel={`Rename ${label}`}
              onCommit={onCommitRename}
              onCancel={onCancelRename}
            />
          </div>
        ) : (
          <Button
            variant="ghost"
            role="tab"
            aria-selected={active}
            title={result.title ? `${label} (${defaultLabel})` : label}
            onClick={onSelect}
            onDoubleClick={(event) => {
              event.preventDefault();
              onStartRename();
            }}
            onKeyDown={(event) => {
              if (event.key === "F2") {
                event.preventDefault();
                onStartRename();
              }
            }}
          >
            <span className="tab-label">{label}</span>
          </Button>
        )}
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
        <ContextMenuItem
          onClick={() => {
            skipFinalFocusRef.current = true;
            onStartRename();
          }}
        >
          <Pencil />
          Rename
          <ContextMenuShortcut>F2</ContextMenuShortcut>
        </ContextMenuItem>
        {result.title && (
          <ContextMenuItem onClick={onResetName}>
            <RotateCcw />
            Reset name
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!canMoveLeft} onClick={onMoveLeft}>
          <ArrowLeft />
          Move left
        </ContextMenuItem>
        <ContextMenuItem disabled={!canMoveRight} onClick={onMoveRight}>
          <ArrowRight />
          Move right
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={fetching} onClick={onClose}>
          <X />
          Close
        </ContextMenuItem>
        <ContextMenuItem disabled={!canCloseOthers} onClick={onCloseOthers}>
          Close others
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export interface PinnedInspectionTabItemProps {
  item: Inspection;
  active: boolean;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  dragProps: TabDragBindings;
  onSelect: () => void;
  onPromote: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  onClose: () => void;
}

export function PinnedInspectionTabItem({
  item,
  active,
  canMoveLeft,
  canMoveRight,
  dragProps,
  onSelect,
  onPromote,
  onMoveLeft,
  onMoveRight,
  onClose,
}: PinnedInspectionTabItemProps) {
  const label = `${item.object.schema}.${item.object.name}`;
  const middleClickClose = useMiddleClickClose(onClose);

  return (
    <ContextMenu>
      <ContextMenuTrigger
        className="result-tab"
        data-active={active}
        {...dragProps}
        {...middleClickClose}
      >
        <Button variant="ghost" role="tab" aria-selected={active} title={label} onClick={onSelect}>
          <span className="tab-label">{label}</span>
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onPromote}>
          <Maximize2 />
          Open in full tab
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!canMoveLeft} onClick={onMoveLeft}>
          <ArrowLeft />
          Move left
        </ContextMenuItem>
        <ContextMenuItem disabled={!canMoveRight} onClick={onMoveRight}>
          <ArrowRight />
          Move right
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onClose}>
          <X />
          Close
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export interface MessagesTabItemProps {
  active: boolean;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  dragProps: TabDragBindings;
  onSelect: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
}

export function MessagesTabItem({
  active,
  canMoveLeft,
  canMoveRight,
  dragProps,
  onSelect,
  onMoveLeft,
  onMoveRight,
}: MessagesTabItemProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger className="result-tab" data-active={active} {...dragProps}>
        <Button variant="ghost" role="tab" aria-selected={active} onClick={onSelect}>
          <span className="tab-label">Messages</span>
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!canMoveLeft} onClick={onMoveLeft}>
          <ArrowLeft />
          Move left
        </ContextMenuItem>
        <ContextMenuItem disabled={!canMoveRight} onClick={onMoveRight}>
          <ArrowRight />
          Move right
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
