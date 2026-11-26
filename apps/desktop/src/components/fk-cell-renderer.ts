import {
  GridCellKind,
  type CustomCell,
  type CustomRenderer,
  type GridCell,
} from "@glideapps/glide-data-grid";

import type { ForeignKeyRef } from "@/ipc/bindings/protocol";

export interface FkCellData {
  readonly kind: "foreign-key";
  readonly displayData: string;
  readonly target: ForeignKeyRef;
  readonly align: "left" | "right";
}

export type FkCell = CustomCell<FkCellData>;

export interface ButtonRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const BUTTON_SIZE = 18;
const BUTTON_RIGHT_MARGIN = 4;
const BUTTON_GAP = 6;
const BUTTON_RADIUS = 4;
const MIN_CELL_WIDTH = BUTTON_SIZE + BUTTON_RIGHT_MARGIN * 2;

export function isFkCell(cell: GridCell): cell is FkCell {
  if (cell.kind !== GridCellKind.Custom) return false;
  const data = cell.data as Partial<FkCellData> | undefined;
  return data?.kind === "foreign-key";
}

export function fkButtonRect(cellWidth: number, cellHeight: number): ButtonRect | null {
  if (cellWidth < MIN_CELL_WIDTH || cellHeight < BUTTON_SIZE) return null;
  return {
    x: cellWidth - BUTTON_RIGHT_MARGIN - BUTTON_SIZE,
    y: Math.round((cellHeight - BUTTON_SIZE) / 2),
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
  };
}

export function isPointInFkButton(
  localX: number,
  localY: number,
  cellWidth: number,
  cellHeight: number,
): boolean {
  const button = fkButtonRect(cellWidth, cellHeight);
  if (!button) return false;
  return (
    localX >= button.x &&
    localX <= button.x + button.width &&
    localY >= button.y &&
    localY <= button.y + button.height
  );
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = "…";
  const ellipsisWidth = ctx.measureText(ellipsis).width;
  if (ellipsisWidth > maxWidth) return "";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(text.slice(0, mid)).width + ellipsisWidth <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low > 0 ? `${text.slice(0, low)}${ellipsis}` : ellipsis;
}

function traceRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawArrowUpRightIcon(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  color: string,
) {
  const half = 3.5;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  // Diagonal shaft from bottom-left to top-right
  ctx.moveTo(centerX - half, centerY + half);
  ctx.lineTo(centerX + half, centerY - half);
  // Arrowhead at top-right
  ctx.moveTo(centerX - 0.5, centerY - half);
  ctx.lineTo(centerX + half, centerY - half);
  ctx.lineTo(centerX + half, centerY + 0.5);
  ctx.stroke();
  ctx.restore();
}

export const fkCellRenderer: CustomRenderer<FkCell> = {
  kind: GridCellKind.Custom,
  isMatch: isFkCell,
  needsHover: true,
  needsHoverPosition: true,
  draw(args, cell) {
    const { ctx, theme, rect, hoverAmount, hoverX, hoverY, overrideCursor } = args;
    const { displayData, align } = cell.data;
    const button = fkButtonRect(rect.width, rect.height);
    const pad = theme.cellHorizontalPadding;
    const textLeft = rect.x + pad;
    const textRight = button ? rect.x + button.x - BUTTON_GAP : rect.x + rect.width - pad;
    const maxTextWidth = Math.max(0, textRight - textLeft);

    if (maxTextWidth > 0 && displayData) {
      ctx.save();
      ctx.fillStyle = theme.textDark;
      ctx.font = theme.baseFontFull;
      ctx.textBaseline = "middle";
      const rendered = truncateText(ctx, displayData, maxTextWidth);
      if (rendered) {
        const textY = rect.y + rect.height / 2;
        if (align === "right") {
          ctx.textAlign = "right";
          ctx.fillText(rendered, textRight, textY);
        } else {
          ctx.textAlign = "left";
          ctx.fillText(rendered, textLeft, textY);
        }
      }
      ctx.restore();
    }

    if (!button) return;

    const buttonHovered =
      hoverX !== undefined &&
      hoverY !== undefined &&
      isPointInFkButton(hoverX, hoverY, rect.width, rect.height);
    if (buttonHovered) {
      overrideCursor?.("pointer");
    }

    const bx = rect.x + button.x;
    const by = rect.y + button.y;

    ctx.save();
    traceRoundedRect(ctx, bx + 0.5, by + 0.5, button.width - 1, button.height - 1, BUTTON_RADIUS);
    ctx.fillStyle = buttonHovered
      ? theme.accentLight
      : hoverAmount > 0
        ? theme.bgHeaderHovered
        : theme.bgCellMedium;
    ctx.fill();
    ctx.strokeStyle = buttonHovered ? theme.linkColor : theme.borderColor;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    drawArrowUpRightIcon(
      ctx,
      bx + button.width / 2,
      by + button.height / 2,
      buttonHovered || hoverAmount > 0 ? theme.linkColor : theme.textMedium,
    );
  },
  measure(ctx, cell, theme) {
    return (
      ctx.measureText(cell.data.displayData).width +
      theme.cellHorizontalPadding * 2 +
      BUTTON_SIZE +
      BUTTON_GAP
    );
  },
};
