import type { ComponentProps } from "react";

import type { ResultGrid as Grid } from "./result-grid";

let grid: typeof Grid | undefined;

export async function loadResultGrid() {
  grid ??= (await import("./result-grid")).ResultGrid;
}

export function ResultGrid(props: ComponentProps<typeof Grid>) {
  const LoadedGrid = grid;
  return LoadedGrid ? <LoadedGrid {...props} /> : null;
}
