import { invoke, isTauri } from "@tauri-apps/api/core";

import { createDevTransport } from "./transport-dev";

interface Health {
  version: string;
}

export function health(signal?: AbortSignal): Promise<Health> {
  if (isTauri()) {
    return invoke<Health>("health");
  }
  if (!import.meta.env.DEV) {
    return Promise.reject(new Error("Browser mode requires the development server."));
  }
  return createDevTransport({
    url: import.meta.env.VITE_STRATA_DEV_URL ?? "http://localhost:7420",
    token: import.meta.env.VITE_STRATA_DEV_TOKEN ?? "",
  }).health(signal);
}
