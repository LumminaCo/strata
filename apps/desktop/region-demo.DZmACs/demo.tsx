import { createRoot } from "react-dom/client";
import { SqlEditor } from "../src/components/sql-editor";
import "../src/styles/tokens.css";

const source = [
  "-- #Region Consultas de Bogotá",
  "SELECT full_name",
  "FROM strata_demo.people",
  "WHERE city = 'Bogotá';",
  "",
  "SELECT count(*) FROM strata_demo.people WHERE city = 'Bogotá';",
  "-- #End",
  "",
  "SELECT count(*) FROM strata_demo.type_zoo;",
].join("\n");

createRoot(document.getElementById("root")!).render(
  <main style={{ margin: 32, border: "1px solid #cbd5e1", borderRadius: 8, overflow: "hidden" }}>
    <header style={{ font: "600 16px system-ui", background: "#ecf1f7", color: "#182332", padding: "12px 16px" }}>Strata · Editor SQL</header>
    <div style={{ padding: 16, minHeight: 205 }}>
      <SqlEditor text={source} onChange={() => {}} savedState={{ current: null }} />
    </div>
  </main>,
);
