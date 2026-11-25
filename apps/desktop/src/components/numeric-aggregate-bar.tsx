import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  aggregateFunctions,
  type AggregateFunction,
  type NumericAggregateSummary,
} from "./numeric-aggregate";

export interface NumericAggregateBarProps {
  summary: NumericAggregateSummary;
  fn: AggregateFunction;
  onChangeFn: (fn: AggregateFunction) => void;
}

export function NumericAggregateBar({ summary, fn, onChangeFn }: NumericAggregateBarProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = summary[fn];

  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  function copyValue() {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    void navigator.clipboard
      .writeText(current.raw)
      .then(() => {
        setCopied(true);
        if (timer.current !== undefined) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  }

  const tooltip = [
    `SUM: ${summary.sum.display}`,
    `AVG: ${summary.avg.display}`,
    `MIN: ${summary.min.display}`,
    `MAX: ${summary.max.display}`,
    `(${summary.count.toLocaleString()} numeric ${summary.count === 1 ? "value" : "values"} — click to copy)`,
  ].join(" · ");

  return (
    <div className="status-aggregation" data-testid="numeric-aggregation">
      <div className="status-aggregation-picker">
        <select
          className="status-aggregation-select"
          aria-label="Aggregate function"
          value={fn}
          onChange={(event) => onChangeFn(event.target.value as AggregateFunction)}
        >
          {aggregateFunctions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <ChevronDown className="status-aggregation-chevron" aria-hidden="true" />
      </div>
      <button
        type="button"
        className="status-aggregation-value"
        title={tooltip}
        aria-label={`Copy ${fn.toUpperCase()} value ${current.display}`}
        data-copied={copied || undefined}
        onClick={copyValue}
      >
        <span data-testid="numeric-aggregation-value">{current.display}</span>
        {copied && <Check className="status-aggregation-copied" aria-hidden="true" />}
      </button>
      {summary.count > 1 && (
        <span className="status-aggregation-count" data-testid="numeric-aggregation-count">
          ({summary.count.toLocaleString()})
        </span>
      )}
    </div>
  );
}
