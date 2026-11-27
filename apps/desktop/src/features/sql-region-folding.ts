import { foldService } from "@codemirror/language";
import { StateField, type Text } from "@codemirror/state";

const regionStart = /^[ \t]*--[ \t]*#Region(?:[ \t]|$)/i;
const regionEnd = /^[ \t]*--[ \t]*#End[ \t]*$/i;

function regionRanges(doc: Text) {
  const ranges = new Map<number, { from: number; to: number }>();
  const openings: { start: number; end: number }[] = [];
  let start = 0;
  for (const line of doc.iterLines()) {
    const end = start + line.length;
    if (regionStart.test(line)) {
      openings.push({ start, end });
    } else if (regionEnd.test(line)) {
      const opening = openings.pop();
      if (opening) ranges.set(opening.start, { from: opening.end, to: end });
    }
    start = end + 1;
  }
  return ranges;
}

const regions = StateField.define({
  create: (state) => regionRanges(state.doc),
  update: (ranges, transaction) =>
    transaction.docChanged ? regionRanges(transaction.newDoc) : ranges,
});

export const sqlRegionFolding = [
  regions,
  foldService.of((state, lineStart) => state.field(regions).get(lineStart) ?? null),
];
