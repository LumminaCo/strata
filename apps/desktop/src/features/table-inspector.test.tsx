import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ObjectDdlView } from "@/features/table-inspector";

const sampleDdl = `CREATE TABLE "strata_demo"."people" (
  "id" integer NOT NULL,
  "full_name" text NOT NULL,
  "email" text,
  PRIMARY KEY ("id")
);`;

describe("ObjectDdlView", () => {
  it("renders a floating top-right Copy DDL button with the copy icon alongside the DDL text", () => {
    const html = renderToStaticMarkup(<ObjectDdlView ddl={sampleDdl} onError={() => {}} />);

    expect(html).toContain('class="object-details object-ddl"');
    expect(html).toContain('class="object-ddl-actions"');
    expect(html).toContain("object-ddl-copy");
    expect(html).toContain("lucide-copy");
    expect(html).toContain("Copy DDL");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("CREATE TABLE");
    expect(html.indexOf("object-ddl-actions")).toBeLessThan(html.indexOf("<pre"));
  });
});
