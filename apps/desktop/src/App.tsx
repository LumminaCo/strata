import { Database, Layers3, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { health } from "@/ipc/client";

const themes = ["system", "light", "dark"] as const;
type Theme = (typeof themes)[number];
const themeIcons = { system: Monitor, light: Sun, dark: Moon };

function readTheme(): Theme {
  const saved = localStorage.getItem("strata.theme");
  return themes.find((theme) => theme === saved) ?? "system";
}

export function App() {
  const [theme, setTheme] = useState(readTheme);
  const [status, setStatus] = useState<"starting" | "ready" | "unavailable">("starting");
  const ThemeIcon = themeIcons[theme];

  useLayoutEffect(() => {
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    function applyTheme() {
      const dark = theme === "dark" || (theme === "system" && preference.matches);
      document.documentElement.classList.toggle("dark", dark);
    }
    applyTheme();
    preference.addEventListener("change", applyTheme);
    return () => preference.removeEventListener("change", applyTheme);
  }, [theme]);

  useEffect(() => {
    const request = new AbortController();
    void health(request.signal).then(
      () => {
        if (!request.signal.aborted) setStatus("ready");
      },
      () => {
        if (!request.signal.aborted) setStatus("unavailable");
      },
    );
    return () => request.abort();
  }, []);

  function changeTheme() {
    const next = themes[(themes.indexOf(theme) + 1) % themes.length] ?? "system";
    localStorage.setItem("strata.theme", next);
    setTheme(next);
  }

  return (
    <div className="workspace">
      <header className="toolbar">
        <div className="brand">
          <Layers3 aria-hidden="true" />
          <span>Strata</span>
        </div>
        <Button
          variant="ghost"
          onClick={changeTheme}
          aria-label={`Theme: ${theme}. Change theme.`}
          title={`Theme: ${theme}. Change theme.`}
        >
          <ThemeIcon aria-hidden="true" />
          <span>
            {theme === "system" ? "System theme" : theme === "light" ? "Light theme" : "Dark theme"}
          </span>
        </Button>
      </header>
      <div className="workspace-body">
        <aside className="explorer" aria-label="Explorer">
          <h2>Explorer</h2>
          <p>No connections</p>
        </aside>
        <main className="query-workspace">
          <section className="editor" aria-label="SQL editor">
            <div className="empty-state">
              <div className="empty-state-icon">
                <Database aria-hidden="true" />
              </div>
              <h1>No connection selected</h1>
            </div>
          </section>
          <section className="results" aria-labelledby="results-title">
            <div className="panel-heading">
              <h2 id="results-title">Results</h2>
            </div>
            <p>No results</p>
          </section>
        </main>
      </div>
      <footer className="status-bar" role="status">
        <span className="status-dot" data-status={status} />
        {status === "ready"
          ? "Ready"
          : status === "unavailable"
            ? "Backend unavailable"
            : "Starting…"}
      </footer>
    </div>
  );
}
