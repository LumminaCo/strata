import { afterEach, expect, test, vi } from "vite-plus/test";

import { createDevTransport } from "./transport-dev";

afterEach(() => {
  vi.unstubAllGlobals();
});

const url = "http://localhost:7420";

test("reads health through the authenticated invoke endpoint", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ version: "0.1.0" }));
  vi.stubGlobal("fetch", fetch);

  await expect(createDevTransport({ url, token: "test-token" }).health()).resolves.toEqual({
    version: "0.1.0",
  });
  expect(fetch).toHaveBeenCalledWith(new URL("/invoke/health", url), {
    method: "POST",
    headers: { Authorization: "Bearer test-token" },
    signal: undefined,
  });
});

test("rejects invalid health responses", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ version: 1 })));
  await expect(createDevTransport({ url, token: "test-token" }).health()).rejects.toThrow(
    "invalid health response",
  );
});

test("rejects a missing token before making a request", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(createDevTransport({ url, token: "" }).health()).rejects.toThrow(
    "requires a development token",
  );
  expect(fetch).not.toHaveBeenCalled();
});
