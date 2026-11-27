import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Filter, Plus, X } from "lucide-react";
import { useState, type Ref } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import type { Cell, ColumnMeta } from "@/ipc/bindings/protocol";

import { ResultFilterInput, type FilterInputHandle } from "./result-filter-input";
import {
  compileFilterExpression,
  moveSortRule,
  removeColumnSort,
  setColumnSort,
  type ResultFilter,
  type SortRule,
} from "./result-query";

interface ResultToolbarProps {
  inputRef?: Ref<FilterInputHandle>;
  columns: readonly ColumnMeta[];
  rows: readonly Cell[][];
  visibleRows: number;
  draftFilter: string;
  filters: readonly ResultFilter[];
  sorts: readonly SortRule[];
  onDraftFilterChange: (value: string) => void;
  onAddFilter: (expression: string) => void;
  onRemoveFilter: (id: string) => void;
  onEditFilter: (item: ResultFilter) => void;
  onClearFilters: () => void;
  onSortsChange: (sorts: SortRule[]) => void;
}

export function ResultToolbar({
  inputRef,
  columns,
  rows,
  visibleRows,
  draftFilter,
  filters,
  sorts,
  onDraftFilterChange,
  onAddFilter,
  onRemoveFilter,
  onEditFilter,
  onClearFilters,
  onSortsChange,
}: ResultToolbarProps) {
  const [submitError, setSubmitError] = useState("");

  function commitDraft() {
    const trimmed = draftFilter.trim();
    if (!trimmed) return;
    const compiled = compileFilterExpression(trimmed, columns);
    if (!compiled.ok) {
      setSubmitError(compiled.error);
      return;
    }
    setSubmitError("");
    onAddFilter(trimmed);
  }

  const hasFilters = filters.length > 0 || draftFilter.trim().length > 0;
  const hasSorts = sorts.length > 0;
  const sortedColumnSet = new Set(sorts.map((rule) => rule.column));
  const unsortedColumns = columns
    .map((column, index) => ({ column, index }))
    .filter(({ index }) => !sortedColumnSet.has(index));

  return (
    <div className="result-toolbar" aria-label="Result filters and sorting">
      <div className="result-toolbar-row">
        <div className="result-filter-field">
          <Filter className="result-filter-icon" aria-hidden="true" />
          <ResultFilterInput
            ref={inputRef}
            value={draftFilter}
            columns={columns}
            rows={rows}
            invalid={!!submitError}
            placeholder="Filter rows (e.g. status = 'active' AND id > 10) · Ctrl+Space"
            ariaLabel="Filter query results"
            onChange={(next) => {
              if (submitError) setSubmitError("");
              onDraftFilterChange(next);
            }}
            onSubmit={commitDraft}
            onEscape={() => {
              setSubmitError("");
              if (draftFilter) onDraftFilterChange("");
            }}
          />
          {draftFilter && (
            <>
              <Button
                type="button"
                variant="outline"
                size="xs"
                title="Add filter chip (Enter)"
                onClick={commitDraft}
              >
                <Plus /> Add
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Clear filter input"
                title="Clear filter input"
                onClick={() => {
                  setSubmitError("");
                  onDraftFilterChange("");
                }}
              >
                <X />
              </Button>
            </>
          )}
        </div>

        <div className="result-toolbar-end">
          {hasFilters && (
            <span className="result-filter-summary" role="status">
              {visibleRows.toLocaleString()} / {rows.length.toLocaleString()}
            </span>
          )}
          {columns.length > 0 && unsortedColumns.length > 0 && (
            <Select
              aria-label="Add sort column"
              size="sm"
              value={null}
              placeholder={hasSorts ? "+ Then by" : "+ Sort by"}
              onValueChange={(colIndex) =>
                onSortsChange(setColumnSort(sorts, Number(colIndex), false))
              }
              items={unsortedColumns.map(({ column, index }) => ({
                value: String(index),
                label: column.name,
              }))}
            />
          )}
        </div>
      </div>

      {submitError && (
        <p className="result-filter-error" role="alert">
          {submitError}
        </p>
      )}

      {(filters.length > 0 || hasSorts) && (
        <div className="result-chips-bar">
          {filters.length > 0 && (
            <div className="result-chip-group" role="group" aria-label="Active filters">
              <span className="result-chip-group-label">Filters</span>
              {filters.map((item) => (
                <span key={item.id} className="result-chip" data-kind="filter">
                  <button
                    type="button"
                    className="result-chip-action"
                    title="Edit filter"
                    onClick={() => {
                      setSubmitError("");
                      onEditFilter(item);
                    }}
                  >
                    {item.expression}
                  </button>
                  <button
                    type="button"
                    className="result-chip-remove"
                    aria-label={`Remove filter ${item.expression}`}
                    title="Remove filter"
                    onClick={() => onRemoveFilter(item.id)}
                  >
                    <X />
                  </button>
                </span>
              ))}
              {filters.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="result-chip-clear"
                  onClick={() => {
                    setSubmitError("");
                    onClearFilters();
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          )}

          {hasSorts && (
            <div className="result-chip-group" role="group" aria-label="Active sorting">
              <span className="result-chip-group-label">Sort</span>
              {sorts.map((rule, priority) => {
                const name = columns[rule.column]?.name ?? `Column ${rule.column + 1}`;
                const DirectionIcon = rule.descending ? ArrowDown : ArrowUp;
                return (
                  <span key={rule.column} className="result-chip" data-kind="sort">
                    {sorts.length > 1 && (
                      <span className="result-chip-priority" aria-hidden="true">
                        {priority + 1}
                      </span>
                    )}
                    <button
                      type="button"
                      className="result-chip-action"
                      title={`Sort ${name} ${rule.descending ? "ascending" : "descending"}`}
                      onClick={() =>
                        onSortsChange(setColumnSort(sorts, rule.column, !rule.descending))
                      }
                    >
                      <span>{name}</span>
                      <DirectionIcon aria-hidden="true" />
                    </button>
                    {sorts.length > 1 && (
                      <>
                        <button
                          type="button"
                          className="result-chip-move"
                          aria-label={`Move sort ${name} earlier`}
                          title="Higher sort priority"
                          disabled={priority === 0}
                          onClick={() => onSortsChange(moveSortRule(sorts, rule.column, -1))}
                        >
                          <ChevronLeft />
                        </button>
                        <button
                          type="button"
                          className="result-chip-move"
                          aria-label={`Move sort ${name} later`}
                          title="Lower sort priority"
                          disabled={priority === sorts.length - 1}
                          onClick={() => onSortsChange(moveSortRule(sorts, rule.column, 1))}
                        >
                          <ChevronRight />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="result-chip-remove"
                      aria-label={`Remove sort on ${name}`}
                      title={`Remove sort on ${name}`}
                      onClick={() => onSortsChange(removeColumnSort(sorts, rule.column))}
                    >
                      <X />
                    </button>
                  </span>
                );
              })}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="result-chip-clear"
                onClick={() => onSortsChange([])}
              >
                Clear sort
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
