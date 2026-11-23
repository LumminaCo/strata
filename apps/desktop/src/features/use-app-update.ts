import { Channel, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { browserMode, errorMessage } from "@/ipc/client";

export type UpdateCheckState = "idle" | "up-to-date" | "error";

export function useAppUpdate(saveWorkspace: () => Promise<void>, notify: (text: string) => void) {
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkState, setCheckState] = useState<UpdateCheckState>("idle");
  const [checkError, setCheckError] = useState("");
  const [status, setStatus] = useState("");
  const installing = useRef(false);
  const checkingRef = useRef(false);
  const inFlight = useRef<Promise<string | null> | null>(null);
  const mounted = useRef(true);
  const callbacks = useRef({ saveWorkspace, notify });
  callbacks.current = { saveWorkspace, notify };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const runCheck = useCallback((): Promise<string | null> => {
    if (!inFlight.current) {
      const request = invoke<string | null>("check_update").finally(() => {
        if (inFlight.current === request) inFlight.current = null;
      });
      inFlight.current = request;
    }
    return inFlight.current;
  }, []);

  useEffect(() => {
    if (browserMode || version) return;
    let active = true;
    async function poll() {
      try {
        const available = await runCheck();
        if (active && available) {
          setVersion(available);
          setCheckState("idle");
          setCheckError("");
        }
      } catch {
        // Automatic background checks fail silently while offline.
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 15 * 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [runCheck, version]);

  const check = useCallback(async () => {
    if (browserMode || checkingRef.current || installing.current) return;
    checkingRef.current = true;
    setChecking(true);
    setCheckError("");
    try {
      const available = await runCheck();
      if (!mounted.current) return;
      setVersion(available);
      if (available) {
        setCheckState("idle");
        callbacks.current.notify(`Strata ${available} is available.`);
      } else {
        setCheckState("up-to-date");
        callbacks.current.notify("Strata is up to date.");
      }
    } catch (error) {
      if (!mounted.current) return;
      const message = errorMessage(error);
      setCheckState("error");
      setCheckError(message);
      callbacks.current.notify(message);
    } finally {
      checkingRef.current = false;
      if (mounted.current) setChecking(false);
    }
  }, [runCheck]);

  const install = useCallback(async () => {
    if (browserMode || !version || installing.current) return;
    installing.current = true;
    setStatus("Saving your workspace…");
    try {
      await callbacks.current.saveWorkspace();
      const channel = new Channel<string>();
      channel.onmessage = setStatus;
      setStatus(`Downloading Strata ${version}…`);
      await invoke("install_update", { channel });
    } catch (error) {
      callbacks.current.notify(errorMessage(error));
    } finally {
      installing.current = false;
      if (mounted.current) setStatus("");
    }
  }, [version]);

  return { version, checking, checkState, checkError, check, install, status, installing };
}
