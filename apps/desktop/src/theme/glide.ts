import type { Theme } from "@glideapps/glide-data-grid";

export function gridTheme(): Partial<Theme> {
  const styles = getComputedStyle(document.documentElement);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const labelSize = styles.getPropertyValue("--font-size-label").trim();
  function color(token: string) {
    let value = styles.getPropertyValue(token).trim();
    while (value.startsWith("var(")) value = styles.getPropertyValue(value.slice(4, -1)).trim();
    if (!context) return value;
    // Glide mixes colors as sRGB, so resolve modern CSS colors before passing them in.
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${(a ?? 255) / 255})`;
  }
  const muted = color("--muted-foreground");
  const surface = color("--grid-header");
  const selected = color("--grid-selection");
  return {
    accentColor: color("--primary"),
    accentFg: color("--primary-foreground"),
    accentLight: selected,
    textDark: color("--foreground"),
    textMedium: muted,
    textLight: color("--grid-null"),
    textHeader: color("--foreground"),
    textGroupHeader: muted,
    textHeaderSelected: color("--foreground"),
    textBubble: color("--foreground"),
    bgIconHeader: surface,
    fgIconHeader: muted,
    bgCell: color("--background"),
    bgCellMedium: color("--grid-stripe"),
    bgHeader: surface,
    bgHeaderHasFocus: selected,
    bgHeaderHovered: color("--muted"),
    bgBubble: selected,
    bgBubbleSelected: selected,
    bgSearchResult: selected,
    borderColor: color("--border"),
    linkColor: color("--workspace-accent"),
    headerFontStyle: `600 ${labelSize}`,
    baseFontStyle: labelSize,
    fontFamily: styles.getPropertyValue("--editor-font").trim(),
    editorFontSize: styles.getPropertyValue("--font-size-ui").trim(),
    cellHorizontalPadding: 9,
  };
}
