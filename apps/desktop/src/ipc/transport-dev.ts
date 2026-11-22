import type { RunEvent, RunRequest } from "./bindings/protocol";

interface DevOptions {
  url: string;
  token: string;
}

export function createDevTransport({ url, token }: DevOptions) {
  let connection: Promise<string> | undefined;
  const streams = new Map<string, { event: (value: RunEvent) => void; disconnect: () => void }>();

  function connect() {
    connection ??= new Promise<string>((resolve, reject) => {
      const socket = openChannel();
      const timeout = setTimeout(() => socket.close(), 5_000);
      socket.onclose = () => {
        clearTimeout(timeout);
        const error = new Error("The development connection closed. Try again.");
        reject(error);
        connection = undefined;
        for (const stream of streams.values()) stream.disconnect();
        streams.clear();
      };
      socket.onmessage = (message: MessageEvent<string>) => {
        const frame = JSON.parse(message.data) as
          | { connectionId: string }
          | { channelId: string; event: RunEvent };
        if ("connectionId" in frame) {
          clearTimeout(timeout);
          resolve(frame.connectionId);
        } else {
          streams.get(frame.channelId)?.event(frame.event);
        }
      };
    }).catch((error: unknown) => {
      connection = undefined;
      throw error;
    });
    return connection;
  }

  function openChannel() {
    if (!token) {
      throw new Error("The browser transport requires a development token.");
    }
    const socketUrl = new URL("/ws", url);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(socketUrl, `strata.${token}`);
  }

  async function post<T>(command: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(new URL(`/invoke/${command}`, url), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      if (response.headers.get("Content-Type")?.includes("application/json")) {
        throw await response.json();
      }
      throw new Error(`Development server returned HTTP ${response.status}.`);
    }
    return (await response.json()) as T;
  }

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

    async dispatch<T>(request: { command: string; args?: unknown }): Promise<T> {
      const connectionId = await connect();
      return post("dispatch", { connectionId, request });
    },

    async run(request: RunRequest, listener: (event: RunEvent) => void) {
      const connectionId = await connect();
      const channelId = crypto.randomUUID();
      const done = new Promise<void>((resolve, reject) => {
        streams.set(channelId, {
          event(event) {
            listener(event);
            if (event.type === "done") resolve();
          },
          disconnect: () =>
            reject(new Error("The development connection closed during the query.")),
        });
      });
      try {
        await Promise.all([post("run_query", { connectionId, channelId, request }), done]);
      } finally {
        streams.delete(channelId);
      }
    },
  };
}
