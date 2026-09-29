/**
 * Version comparison — cell by cell, on real workbooks built in memory.
 */
const { expect } = require('chai');
const XLSX = require('xlsx');

const { diffWorkbookBuffers } = require('../src/services/v2/driveVersionDiff');

// { SheetName: [[row], [row]] } -> xlsx buffer. A cell given as
// { f: 'SUM(A1:A2)', v: 3 } is written as a formula.
const workbook = (sheets) => {
  const book = XLSX.utils.book_new();
  Object.entries(sheets).forEach(([name, rows]) => {
    const sheet = XLSX.utils.aoa_to_sheet(rows.map((row) => row.map((cell) => (
      cell && typeof cell === 'object' ? { t: 'n', v: cell.v, f: cell.f } : cell
    ))));
    XLSX.utils.book_append_sheet(book, sheet, name);
  });
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
};

const changesOf = (result, sheetName) => result.sheets.find((s) => s.name === sheetName)?.changes || [];

describe('Drive version comparison', () => {
  it('finds a changed, an added and a removed cell', () => {
    const before = workbook({ Budget: [['Item', 'Cost'], ['Camera', 100], ['Lights', 50]] });
    const after = workbook({ Budget: [['Item', 'Cost'], ['Camera', 120], ['', 50], ['Grip', 30]] });

    const result = diffWorkbookBuffers(before, after);
    const changes = changesOf(result, 'Budget');

    expect(result.total).to.equal(4);
    expect(changes.find((c) => c.c === 'B2')).to.include({ k: 'changed', b: '100', a: '120' });
    expect(changes.find((c) => c.c === 'A3')).to.include({ k: 'removed', b: 'Lights', a: '' });
    expect(changes.find((c) => c.c === 'A4')).to.include({ k: 'added', b: '', a: 'Grip' });
    expect(changes.find((c) => c.c === 'B4')).to.include({ k: 'added', a: '30' });
  });

  it('reports a formula change when the shown value stays the same', () => {
    const before = workbook({ S: [[1], [2], [{ f: 'A1+A2', v: 3 }]] });
    const after = workbook({ S: [[1], [2], [{ f: 'SUM(A1:A2)', v: 3 }]] });

    const [change] = changesOf(diffWorkbookBuffers(before, after), 'S');
    expect(change).to.include({
      c: 'A3', k: 'formula', b: '=A1+A2', a: '=SUM(A1:A2)',
    });
  });

  it('leaves out sheets with no changes', () => {
    const before = workbook({ Same: [['x']], Edited: [['a']] });
    const after = workbook({ Same: [['x']], Edited: [['b']] });

    const result = diffWorkbookBuffers(before, after);
    expect(result.sheets.map((s) => s.name)).to.deep.equal(['Edited']);
  });

  it('marks added and removed sheets', () => {
    const before = workbook({ Old: [['gone']], Keep: [['k']] });
    const after = workbook({ Keep: [['k']], New: [['fresh', 'data']] });

    const result = diffWorkbookBuffers(before, after);
    const byName = Object.fromEntries(result.sheets.map((s) => [s.name, s]));
    expect(byName.New).to.include({ status: 'added', total: 2 });
    expect(byName.Old).to.include({ status: 'removed', total: 1 });
    expect(byName.Keep).to.equal(undefined);
  });

  it('caps stored changes but still counts every one', () => {
    const rows = (value) => Array.from({ length: 50 }, (_, i) => [`${value}${i}`]);
    const result = diffWorkbookBuffers(workbook({ S: rows('a') }), workbook({ S: rows('b') }), { maxChanges: 10 });

    expect(result.total).to.equal(50);
    expect(result.truncated).to.equal(true);
    expect(changesOf(result, 'S')).to.have.length(10);
  });

  it('shortens very long values', () => {
    const long = 'x'.repeat(500);
    const [change] = changesOf(diffWorkbookBuffers(workbook({ S: [['short']] }), workbook({ S: [[long]] })), 'S');
    expect(change.a.length).to.equal(200);
    expect(change.a.endsWith('…')).to.equal(true);
  });

  it('reports nothing for identical workbooks', () => {
    const book = workbook({ S: [['a', 1], ['b', 2]] });
    expect(diffWorkbookBuffers(book, book)).to.deep.equal({ total: 0, truncated: false, sheets: [] });
  });
});
