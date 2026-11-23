import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { isBrowserShortcut } from "./features/keymap";
import "./styles/globals.css";
import "./styles/workspace.css";

if (import.meta.env.PROD) {
  // Bubble phase on window: app shortcuts run first, then the webview default is cancelled.
  window.addEventListener("contextmenu", (event) => event.preventDefault());
  window.addEventListener("keydown", (event) => {
    if (isBrowserShortcut(event)) event.preventDefault();
  });
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Strata could not find the application root.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
