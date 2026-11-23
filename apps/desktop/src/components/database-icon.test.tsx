import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";

import { DatabaseIcon, type DatabaseKind } from "./database-icon";

test("renders distinct SVG icons for PostgreSQL, SQL Server, and Oracle", () => {
  const kinds: DatabaseKind[] = ["postgres", "sqlserver", "oracle"];
  const rendered = kinds.map((kind) => renderToStaticMarkup(<DatabaseIcon kind={kind} />));

  expect(new Set(rendered).size).toBe(3);
  kinds.forEach((kind, index) => {
    const markup = rendered[index]!;
    expect(markup).toContain(`data-db-kind="${kind}"`);
    expect(markup).toContain('class="db-icon"');
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).toContain('aria-hidden="true"');
  });
});

test("preserves custom className and omits aria-hidden when labelled", () => {
  const markup = renderToStaticMarkup(
    <DatabaseIcon kind="oracle" className="custom-icon" aria-label="Oracle" />,
  );

  expect(markup).toContain('class="db-icon custom-icon"');
  expect(markup).toContain('aria-label="Oracle"');
  expect(markup).not.toContain("aria-hidden");
});
