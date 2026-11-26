import {
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";

import { Input } from "@/components/ui/input";
import type { Cell, ColumnMeta, Connection } from "@/ipc/bindings/protocol";

import {
  applyFilterSuggestion,
  compileFilterExpression,
  getFilterSuggestions,
  type FilterSuggestion,
} from "./result-query";

export interface FilterInputHandle {
  focus: (options?: { openSuggestions?: boolean; selectAll?: boolean }) => void;
}

interface ResultFilterInputProps {
  ref?: Ref<FilterInputHandle>;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  onEscape?: () => void;
  columns: readonly ColumnMeta[];
  rows: readonly Cell[][];
  dialect?: Connection["kind"];
  placeholder?: string;
  ariaLabel?: string;
  invalid?: boolean;
  className?: string;
}

const SUGGESTION_KIND_LABELS: Record<FilterSuggestion["kind"], string> = {
  column: "col",
  operator: "op",
  value: "val",
  keyword: "kw",
};

function shouldKeepOpenAfterAccept(suggestion: FilterSuggestion): boolean {
  if (suggestion.kind === "column") return suggestion.insertText.endsWith(" ");
  if (suggestion.kind === "keyword") return true;
  if (suggestion.kind === "operator") {
    return suggestion.insertText !== "IS NULL" && suggestion.insertText !== "IS NOT NULL";
  }
  return false;
}

export function ResultFilterInput({
  ref,
  value,
  onChange,
  onSubmit,
  onEscape,
  columns,
  rows,
  dialect,
  placeholder = "Filter results (e.g. column = 'value' AND …)",
  ariaLabel = "Filter results",
  invalid = false,
  className,
}: ResultFilterInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const [cursor, setCursor] = useState(value.length);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [userNavigated, setUserNavigated] = useState(false);
  const pendingCursor = useRef<number | null>(null);

  // Cache distinct values lazily per column for the current rows snapshot.
  const valueCache = useMemo(
    () => new Map<number, { value: Exclude<Cell, null>; count: number }[]>(),
    [rows],
  );

  const clampedCursor = Math.min(cursor, value.length);
  const suggestions = useMemo(
    () =>
      open ? getFilterSuggestions(value, clampedCursor, columns, rows, valueCache, dialect) : [],
    [open, value, clampedCursor, columns, rows, valueCache, dialect],
  );

  const boundedActiveIndex =
    suggestions.length > 0 ? Math.min(activeIndex, suggestions.length - 1) : 0;

  useEffect(() => {
    if (pendingCursor.current === null) return;
    const pos = pendingCursor.current;
    pendingCursor.current = null;
    const element = inputRef.current;
    if (element && document.activeElement === element) {
      element.setSelectionRange(pos, pos);
    }
  }, [value]);

  useEffect(() => {
    if (!open || suggestions.length === 0) return;
    const activeOption = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${boundedActiveIndex}"]`,
    );
    activeOption?.scrollIntoView({ block: "nearest" });
  }, [open, boundedActiveIndex, suggestions.length]);

  useImperativeHandle(
    ref,
    () => ({
      focus(options) {
        const element = inputRef.current;
        if (!element) return;
        element.focus();
        const end = element.value.length;
        if (options?.selectAll) {
          element.setSelectionRange(0, end);
        } else {
          element.setSelectionRange(end, end);
        }
        setCursor(end);
        if (options?.openSuggestions ?? true) {
          setOpen(true);
          setActiveIndex(0);
          setUserNavigated(false);
        }
      },
    }),
    [],
  );

  function acceptSuggestion(suggestion: FilterSuggestion) {
    const applied = applyFilterSuggestion(value, suggestion);
    pendingCursor.current = applied.cursor;
    setCursor(applied.cursor);
    setActiveIndex(0);
    setUserNavigated(false);
    setOpen(shouldKeepOpenAfterAccept(suggestion));
    onChange(applied.text);
    inputRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      const pos = event.currentTarget.selectionStart ?? value.length;
      setCursor(pos);
      setOpen(true);
      setActiveIndex(0);
      setUserNavigated(false);
      return;
    }

    if (open && suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((current) => (current + 1) % suggestions.length);
        setUserNavigated(true);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
        setUserNavigated(true);
        return;
      }
      if (event.key === "Tab") {
        const chosen = suggestions[boundedActiveIndex];
        if (chosen) {
          event.preventDefault();
          acceptSuggestion(chosen);
          return;
        }
      }
      if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
        const chosen = suggestions[boundedActiveIndex];
        const compiled = compileFilterExpression(value, columns);
        const alreadyValidExpression = compiled.ok && compiled.mode === "expression";
        const shouldAccept =
          chosen !== undefined &&
          (userNavigated || (value.trim().length > 0 && !alreadyValidExpression));
        if (shouldAccept) {
          event.preventDefault();
          acceptSuggestion(chosen);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        setUserNavigated(false);
        return;
      }
    }

    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
      if (onSubmit) {
        event.preventDefault();
        setOpen(false);
        setUserNavigated(false);
        onSubmit();
      }
      return;
    }

    if (event.key === "Escape") {
      setOpen(false);
      setUserNavigated(false);
      onEscape?.();
    }
  }

  const showPopover = open && suggestions.length > 0;
  const activeOptionId = showPopover ? `${listboxId}-opt-${boundedActiveIndex}` : undefined;

  return (
    <div className="result-filter-combobox">
      <Input
        ref={inputRef}
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={showPopover}
        aria-controls={showPopover ? listboxId : undefined}
        aria-activedescendant={activeOptionId}
        aria-invalid={invalid || undefined}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        className={className}
        value={value}
        onFocus={(event) => {
          const pos = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
          setCursor(pos);
          setOpen(true);
          setActiveIndex(0);
          setUserNavigated(false);
        }}
        onBlur={() => {
          setOpen(false);
          setUserNavigated(false);
        }}
        onClick={(event) => {
          const pos = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
          setCursor(pos);
          setOpen(true);
          setUserNavigated(false);
        }}
        onKeyUp={(event) => {
          if (
            event.key === "ArrowLeft" ||
            event.key === "ArrowRight" ||
            event.key === "Home" ||
            event.key === "End"
          ) {
            const pos = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
            setCursor(pos);
          }
        }}
        onChange={(event) => {
          const next = event.target.value;
          const pos = event.target.selectionStart ?? next.length;
          setCursor(pos);
          setOpen(true);
          setActiveIndex(0);
          setUserNavigated(false);
          onChange(next);
        }}
        onKeyDown={handleKeyDown}
      />
      {showPopover && (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Filter suggestions"
          className="result-autocomplete"
        >
          {suggestions.map((suggestion, index) => {
            const active = index === boundedActiveIndex;
            return (
              <button
                key={`${suggestion.kind}:${suggestion.label}:${index}`}
                id={`${listboxId}-opt-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={active}
                data-active={active}
                data-index={index}
                data-kind={suggestion.kind}
                className="result-autocomplete-item"
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  acceptSuggestion(suggestion);
                }}
              >
                <span className="result-autocomplete-kind">
                  {SUGGESTION_KIND_LABELS[suggestion.kind]}
                </span>
                <span className="result-autocomplete-label">{suggestion.label}</span>
                {suggestion.detail && (
                  <span className="result-autocomplete-detail">{suggestion.detail}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
