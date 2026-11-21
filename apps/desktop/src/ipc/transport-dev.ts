interface DevOptions {
  url: string;
  token: string;
}

export function createDevTransport({ url, token }: DevOptions) {
  return {
    async health(signal?: AbortSignal) {
      if (!token) {
        throw new Error("The browser transport requires a development token.");
      }
      const response = await fetch(new URL("/invoke/health", url), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      if (!response.ok) {
        throw new Error(`Development server returned HTTP ${response.status}.`);
      }
      const payload: unknown = await response.json();
      if (
        !payload ||
        typeof payload !== "object" ||
        !("version" in payload) ||
        typeof payload.version !== "string"
      ) {
        throw new Error("Development server returned an invalid health response.");
      }
      return { version: payload.version };
    },

    openChannel() {
      if (!token) {
        throw new Error("The browser transport requires a development token.");
      }
      const socketUrl = new URL("/ws", url);
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(socketUrl, `strata.${token}`);
    },
  };
}
