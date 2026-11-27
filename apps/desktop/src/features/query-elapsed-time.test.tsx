import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { QueryElapsedTime } from "@/features/query-elapsed-time";

afterEach(() => vi.restoreAllMocks());

it.each([
  [0, "0s"],
  [59_999, "59s"],
  [60_000, "1m 0s"],
  [70_000, "1m 10s"],
  [135_000, "2m 15s"],
])("shows %i ms of query runtime as %s", (elapsedMs, expected) => {
  const startedAt = 2_500;
  vi.spyOn(performance, "now").mockReturnValue(startedAt + elapsedMs);

  const markup = renderToStaticMarkup(<QueryElapsedTime startedAt={startedAt} />);

  expect(markup).toContain(`>${expected}</span>`);
});
