import { GridCellKind } from "@glideapps/glide-data-grid";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  fkButtonRect,
  fkCellRenderer,
  isFkCell,
  isPointInFkButton,
  type FkCell,
} from "./fk-cell-renderer";

function sampleFkCell(align: "left" | "right" = "right", displayData = "130"): FkCell {
  return {
    kind: GridCellKind.Custom,
    allowOverlay: false,
    readonly: true,
    copyData: displayData,
    contentAlign: align,
    data: {
      kind: "foreign-key",
      displayData,
      target: { schema: "public", table: "customer", column: "customer_id" },
      align,
    },
  };
}

describe("fk cell renderer", () => {
  it("computes button bounds and hit-tests pointer coordinates", () => {
    const rect = fkButtonRect(140, 25);
    expect(rect).toEqual({ x: 118, y: 4, width: 18, height: 18 });
    expect(isPointInFkButton(125, 12, 140, 25)).toBe(true);
    expect(isPointInFkButton(118, 4, 140, 25)).toBe(true);
    expect(isPointInFkButton(136, 22, 140, 25)).toBe(true);
    expect(isPointInFkButton(50, 12, 140, 25)).toBe(false);
    expect(isPointInFkButton(117, 12, 140, 25)).toBe(false);
    expect(fkButtonRect(20, 25)).toBeNull();
  });

  it("matches foreign-key custom cells and draws text + interactive button", () => {
    const cell = sampleFkCell("right", "130");
    expect(isFkCell(cell)).toBe(true);
    expect(
      isFkCell({
        kind: GridCellKind.Text,
        data: "130",
        displayData: "130",
        allowOverlay: false,
      }),
    ).toBe(false);

    const fillText = vi.fn();
    const overrideCursor = vi.fn();
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      fillText,
      measureText: (text: string) => ({ width: text.length * 7 }),
      fillStyle: "",
      strokeStyle: "",
      font: "",
      textAlign: "left",
      textBaseline: "middle",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
    } as unknown as CanvasRenderingContext2D;

    const theme = {
      cellHorizontalPadding: 9,
      textDark: "#18243a",
      textMedium: "#52627a",
      linkColor: "#234a9c",
      accentLight: "#e5eeff",
      bgHeaderHovered: "#edf2f8",
      bgCellMedium: "#f5f8fc",
      borderColor: "#dbe3ef",
      baseFontFull: "12px monospace",
    } as never;

    fkCellRenderer.draw(
      {
        ctx,
        theme,
        col: 1,
        row: 0,
        rect: { x: 100, y: 50, width: 140, height: 25 },
        highlighted: false,
        hoverAmount: 1,
        hoverX: 126,
        hoverY: 12,
        cellFillColor: "#ffffff",
        imageLoader: {} as never,
        spriteManager: {} as never,
        hyperWrapping: false,
        cell,
        requestAnimationFrame: vi.fn(),
        drawState: [undefined, vi.fn()],
        frameTime: 0,
        overrideCursor,
      },
      cell,
    );

    expect(overrideCursor).toHaveBeenCalledWith("pointer");
    expect(fillText).toHaveBeenCalledWith("130", 100 + 118 - 6, 50 + 12.5);
    expect(fkCellRenderer.measure?.(ctx, cell, theme)).toBeGreaterThan(21 + 18 + 18);
  });
});
