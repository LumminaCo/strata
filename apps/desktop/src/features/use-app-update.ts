import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

import { browserMode, errorMessage } from "@/ipc/client";

export function useAppUpdate(saveWorkspace: () => Promise<void>, notify: (text: string) => void) {
  const [version, setVersion] = useState<string | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [status, setStatus] = useState("");
  const installing = useRef(false);

  useEffect(() => {
    if (browserMode || version) return;
    let mounted = true;
    async function check() {
      try {
        const available = await invoke<string | null>("check_update");
        if (mounted) {
          setVersion(available);
          setCheckFailed(false);
        }
      } catch {
        if (mounted) setCheckFailed(true);
      }
    }
    void check();
    const timer = setInterval(() => void check(), 15 * 60_000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [version]);

  async function retryCheck() {
    try {
      const available = await invoke<string | null>("check_update");
      setVersion(available);
      setCheckFailed(false);
      if (!available) notify("Strata is up to date.");
    } catch (error) {
      notify(errorMessage(error));
    }
  }

  async function install() {
    if (!version || installing.current) return;
    installing.current = true;
    setStatus("Saving your workspace…");
    try {
      await saveWorkspace();
      const channel = new Channel<string>();
      channel.onmessage = setStatus;
      setStatus(`Downloading Strata ${version}…`);
      await invoke("install_update", { channel });
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      installing.current = false;
      setStatus("");
    }
  }

  return { version, checkFailed, retryCheck, install, status, installing };
}
