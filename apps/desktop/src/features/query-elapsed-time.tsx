import { useEffect, useState } from "react";

function elapsedSeconds(startedAt: number) {
  return Math.floor((performance.now() - startedAt) / 1_000);
}

export function QueryElapsedTime({ startedAt }: { startedAt: number }) {
  const [seconds, setSeconds] = useState(() => elapsedSeconds(startedAt));

  useEffect(() => {
    const interval = window.setInterval(() => setSeconds(elapsedSeconds(startedAt)), 1_000);
    return () => window.clearInterval(interval);
  }, [startedAt]);

  const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return (
    <span className="tabular-nums" role="timer" aria-label="Query elapsed time">
      {duration}
    </span>
  );
}
