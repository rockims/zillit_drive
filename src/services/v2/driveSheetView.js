import zlib from 'zlib';
import * as XLSX from 'xlsx';

/**
 * Open read-only spreadsheets at the top.
 *
 * An xlsx stores each sheet's cursor (<selection activeCell="E26">) and
 * scroll position (<sheetView topLeftCell>, or <pane topLeftCell> for the
 * scrolling part of a sheet with frozen rows or columns) from its last
 * save, and the editor restores them. In edit mode the web client jumps to
 * A1 after loading, but the editor ignores commands in read-only mode, so
 * read-only opens (previews, view-only users, share links, old versions)
 * landed wherever the last saver left off.
 *
 * For those opens Drive serves a copy with the saved cursor removed and
 * the scroll position put back at the top. Frozen rows and columns, zoom,
 * gridlines and the active sheet are kept. The stored file is never
 * touched, and read-only sessions never save.
 */

const MAX_BYTES = Number(process.env.DRIVE_READONLY_TOP_MAX_BYTES) || 10 * 1024 * 1024;
const SHEET_ENTRY = /\/xl\/worksheets\/sheet\d+\.xml$/i;
const RESETTABLE = new Set(['xlsx', 'xlsm']);

// SheetJS's own deflate compresses 2-3x worse than zlib; use Node's so the
// copy we serve stays about the size of the stored file. If this Node's zlib
// can't be used, SheetJS logs it and keeps its own.
XLSX.CFB.utils.use_zlib(zlib);

const attribute = (tag, name) => (tag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];

// A frozen pane's topLeftCell is where its scrolling part was scrolled to;
// move it back to the first cell past the frozen rows and columns. Other
// panes (a plain split, measured in twips) are left as they are.
const resetPane = (pane) => {
  if (!/^frozen(Split)?$/.test(attribute(pane, 'state') || '')) return pane;
  if (attribute(pane, 'topLeftCell') === undefined) return pane;
  const top = XLSX.utils.encode_cell({
    c: Math.floor(Number(attribute(pane, 'xSplit')) || 0),
    r: Math.floor(Number(attribute(pane, 'ySplit')) || 0),
  });
  return pane.replace(/\btopLeftCell="[^"]*"/, `topLeftCell="${top}"`);
};

// Remove the saved cursor and scroll position from one sheet's XML.
const stripSheetPosition = (xml) => {
  const start = xml.indexOf('<sheetViews');
  if (start < 0) return xml;
  const close = xml.indexOf('</sheetViews>', start);
  if (close < 0) return xml;

  const views = xml.slice(start, close)
    .replace(/(<sheetView\b[^>]*?)\s+topLeftCell="[^"]*"/g, '$1')
    .replace(/<pane\b[^>]*>/g, resetPane)
    // Where the cursor was; without it the editor starts at the top
    .replace(/<selection\b[^>]*\/>/g, '')
    .replace(/<selection\b[^>]*>[\s\S]*?<\/selection>/g, '');

  return xml.slice(0, start) + views + xml.slice(close);
};

const canReset = ({ extension, sizeBytes }) => RESETTABLE.has(String(extension || '').toLowerCase())
  && (!sizeBytes || sizeBytes <= MAX_BYTES);

/**
 * Return the workbook with every sheet's saved cursor and scroll position
 * reset, or the original buffer if nothing needed changing. Never throws:
 * anything unexpected serves the file as it is.
 */
const resetSavedPosition = (buffer) => {
  try {
    const container = XLSX.CFB.read(buffer, { type: 'buffer' });
    let changed = false;

    container.FullPaths.forEach((entryPath, index) => {
      if (!SHEET_ENTRY.test(entryPath)) return;
      const entry = container.FileIndex[index];
      if (!entry?.content) return;
      const xml = Buffer.from(entry.content).toString('utf8');
      const next = stripSheetPosition(xml);
      if (next !== xml) {
        entry.content = Buffer.from(next, 'utf8');
        entry.size = entry.content.length;
        changed = true;
      }
    });

    if (!changed) return buffer;
    return Buffer.from(XLSX.CFB.write(container, { fileType: 'zip', type: 'buffer', compression: true }));
  } catch (error) {
    console.error('[drive_sheet_view_reset_failed]:', error.message);
    return buffer;
  }
};

export {
  stripSheetPosition,
  MAX_BYTES,
};

export default {
  canReset,
  resetSavedPosition,
};
