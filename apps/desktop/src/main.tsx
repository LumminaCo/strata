import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles/globals.css";
import "./styles/workspace.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Strata could not find the application root.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
