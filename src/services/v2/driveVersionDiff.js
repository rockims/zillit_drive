import * as XLSX from 'xlsx';

/**
 * Cell-by-cell comparison of two spreadsheet versions.
 *
 * Pure: takes two file buffers, returns what changed. Runs in a child
 * process (driveVersionDiffChild.js) so a large workbook can't stall or
 * exhaust the API process.
 *
 * Each change is one of:
 *   added    empty before, has a value or formula now
 *   removed  had a value or formula, empty now
 *   changed  the shown value differs
 *   formula  same shown value, different formula
 */

// Longest value kept per side of a change; the UI shows a preview, not the
// whole cell.
const MAX_TEXT = 200;
const DEFAULT_MAX_CHANGES = 5000;

const trimText = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);

// What the cell shows: the formatted text when there is one ("1,250.00"),
// else the raw value.
const cellText = (cell) => {
  if (!cell) return '';
  if (cell.w != null) return trimText(String(cell.w));
  if (cell.v == null) return '';
  return trimText(String(cell.v));
};

const cellFormula = (cell) => (cell && cell.f ? trimText(`=${cell.f}`) : '');

const readWorkbook = (buffer) => XLSX.read(buffer, {
  type: 'buffer',
  dense: true,
  cellFormula: true,
  cellText: true,
  cellHTML: false,
  cellStyles: false,
  cellDates: false,
  sheetStubs: false,
});

const rowsOf = (sheet) => (sheet && sheet['!data']) || [];

/**
 * Compare one sheet. Either side may be missing (an added or removed
 * sheet). `budget.left` caps how many changes are kept across the whole
 * workbook; every change is still counted in `total`.
 */
const compareSheet = ({
  name, before, after, budget,
}) => {
  const rowsBefore = rowsOf(before);
  const rowsAfter = rowsOf(after);
  const rowCount = Math.max(rowsBefore.length, rowsAfter.length);
  const changes = [];
  let total = 0;

  for (let r = 0; r < rowCount; r += 1) {
    const rowBefore = rowsBefore[r] || [];
    const rowAfter = rowsAfter[r] || [];
    const colCount = Math.max(rowBefore.length, rowAfter.length);

    for (let c = 0; c < colCount; c += 1) {
      const textBefore = cellText(rowBefore[c]);
      const textAfter = cellText(rowAfter[c]);
      const formulaBefore = cellFormula(rowBefore[c]);
      const formulaAfter = cellFormula(rowAfter[c]);
      const hadContent = !!(textBefore || formulaBefore);
      const hasContent = !!(textAfter || formulaAfter);

      let kind = null;
      if (!hadContent && hasContent) kind = 'added';
      else if (hadContent && !hasContent) kind = 'removed';
      else if (textBefore !== textAfter) kind = 'changed';
      else if (formulaBefore !== formulaAfter) kind = 'formula';

      if (kind) {
        total += 1;
        if (budget.left > 0) {
          // One budget shared across sheets, so the cap is per workbook.
          // eslint-disable-next-line no-param-reassign
          budget.left -= 1;
          const showFormula = kind === 'formula';
          changes.push({
            c: XLSX.utils.encode_cell({ r, c }),
            r,
            col: c,
            k: kind,
            b: showFormula ? formulaBefore : textBefore,
            a: showFormula ? formulaAfter : textAfter,
          });
        }
      }
    }
  }

  let status = 'changed';
  if (!before) status = 'added';
  else if (!after) status = 'removed';

  return {
    name, status, total, changes,
  };
};

/**
 * Compare two workbooks. Sheets appear in the new version's order, then
 * any sheets that were removed. Unchanged sheets are left out.
 */
const diffWorkbookBuffers = (bufferBefore, bufferAfter, { maxChanges = DEFAULT_MAX_CHANGES } = {}) => {
  const before = readWorkbook(bufferBefore);
  const after = readWorkbook(bufferAfter);

  const names = [
    ...after.SheetNames,
    ...before.SheetNames.filter((name) => !after.SheetNames.includes(name)),
  ];

  const budget = { left: maxChanges };
  const sheets = [];
  let total = 0;

  names.forEach((name) => {
    const inBefore = before.SheetNames.includes(name);
    const inAfter = after.SheetNames.includes(name);
    const sheet = compareSheet({
      name,
      before: inBefore ? before.Sheets[name] : null,
      after: inAfter ? after.Sheets[name] : null,
      budget,
    });
    // Added and removed sheets always show, even when empty.
    if (sheet.total > 0 || sheet.status !== 'changed') {
      sheets.push(sheet);
      total += sheet.total;
    }
  });

  return {
    total,
    truncated: total > maxChanges,
    sheets,
  };
};

export {
  diffWorkbookBuffers,
  DEFAULT_MAX_CHANGES,
};
