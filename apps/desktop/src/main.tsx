import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { isBrowserShortcut } from "./features/keymap";
import "./styles/globals.css";
import "./styles/workspace.css";

const textFields =
  "textarea, input:not([type]), input:is([type=text], [type=password], [type=number], [type=search], [type=email], [type=url])";

if (import.meta.env.PROD) {
  // Bubble phase on window: app shortcuts run first, then the webview default is cancelled.
  window.addEventListener("contextmenu", (event) => {
    // Text fields (inputs, textareas, the SQL editor) keep the native Cut/Copy/Paste menu.
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable || target?.matches?.(textFields)) return;
    event.preventDefault();
  });
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
