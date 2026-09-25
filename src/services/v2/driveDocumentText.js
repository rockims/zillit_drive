import * as XLSX from 'xlsx';

/**
 * The text of a document or presentation, paragraph by paragraph, for
 * comparing versions.
 *
 * Reads every text format the editor opens:
 *   documents      docx, doc, odt, rtf, txt
 *   presentations  pptx, ppt, odp (one section per slide)
 *
 * Each paragraph is { section, text }: section is "Document" or
 * "Slide 3", text has its whitespace collapsed. Empty paragraphs are left
 * out. Only the body counts: headers, footers, comments, speaker notes and
 * tracked deletions don't. Pure, and throws on a file it can't read.
 */

const DOCUMENT_EXTENSIONS = new Set(['docx', 'doc', 'odt', 'rtf', 'txt']);
const PRESENTATION_EXTENSIONS = new Set(['pptx', 'ppt', 'odp']);
const BODY = 'Document';

const cp1252 = new TextDecoder('windows-1252');

const collapse = (text) => text.replace(/\s+/g, ' ').trim();

const paragraph = (section, text) => ({ section, text: collapse(text) });

const keepText = (paragraphs) => paragraphs.filter((p) => p.text);

/* ───────────── Containers (zip and OLE) ───────────── */

const openContainer = (buffer) => XLSX.CFB.read(buffer, { type: 'buffer' });

// An entry by its path from the top of the container, e.g.
// "word/document.xml" (not an embedded object's file of the same name).
const entryBytes = (container, name) => {
  const wanted = `${container.FullPaths[0]}${name}`.toLowerCase();
  const index = container.FullPaths.findIndex((p) => p.toLowerCase() === wanted);
  if (index < 0) return null;
  const { content } = container.FileIndex[index];
  return content && content.length ? Buffer.from(content) : null;
};

const entryText = (container, name) => {
  const bytes = entryBytes(container, name);
  return bytes ? bytes.toString('utf8') : null;
};

/* ───────────── XML ───────────── */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

const decodeEntities = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
  if (name[0] === '#') {
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10FFFF ? String.fromCodePoint(code) : match;
  }
  return ENTITIES[name.toLowerCase()] ?? match;
});

// Tags (attribute values may hold ">"), comments, CDATA, declarations, text.
const XML_TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[!?][^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>|([^<]+)/g;

const attributeOf = (attributes, name) => {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`));
  return match ? decodeEntities(match[2] ?? match[3]) : undefined;
};

/**
 * Walk an XML document, calling open(name, attributes, selfClosing),
 * close(name) and text(decodedText). Elements named in `skip` are passed
 * over with everything inside them.
 */
const walkXml = (xml, {
  open = () => {}, close = () => {}, text = () => {}, skip = new Set(),
}) => {
  let skipping = 0;
  XML_TOKEN.lastIndex = 0;
  let match = XML_TOKEN.exec(xml);
  while (match) {
    const [, cdata, slash, name, attributes, selfClosing, chars] = match;
    if (name) {
      if (skipping) {
        if (!selfClosing) skipping += slash ? -1 : 1;
      } else if (slash) {
        close(name);
      } else if (skip.has(name)) {
        if (!selfClosing) skipping = 1;
      } else {
        open(name, attributes, !!selfClosing);
      }
    } else if (!skipping) {
      if (chars != null) text(decodeEntities(chars));
      else if (cdata != null) text(cdata);
    }
    match = XML_TOKEN.exec(xml);
  }
};

/**
 * Paragraphs from XML where `paragraphTags` open a paragraph. Text counts
 * only inside `textTags` (or anywhere in a paragraph when textTags is
 * null); `spaceTags` stand for a space. `sectionOf` names the section for
 * an element, if it starts one.
 */
const xmlParagraphs = (xml, {
  paragraphTags, textTags = null, spaceTags = new Set(), skip, sectionOf = () => null, section = BODY,
}) => {
  const paragraphs = [];
  const open = [];
  let inText = 0;
  let current = section;

  walkXml(xml, {
    skip,
    open(name, attributes, selfClosing) {
      const next = sectionOf(name, attributes);
      if (next) current = next;
      if (paragraphTags.has(name) && !selfClosing) open.push([]);
      else if (textTags && textTags.has(name) && !selfClosing) inText += 1;
      else if (spaceTags.has(name) && open.length) open[open.length - 1].push(' ');
    },
    close(name) {
      if (paragraphTags.has(name) && open.length) paragraphs.push(paragraph(current, open.pop().join('')));
      else if (textTags && textTags.has(name) && inText) inText -= 1;
    },
    text(chars) {
      if (open.length && (!textTags || inText)) open[open.length - 1].push(chars);
    },
  });
  return keepText(paragraphs);
};

/* ───────────── Office Open XML: docx, pptx ───────────── */

// Text boxes are stored twice (modern and fallback); read the modern copy.
const OOXML_SKIP = new Set(['mc:Fallback']);

const docxParagraphs = (buffer) => {
  const xml = entryText(openContainer(buffer), 'word/document.xml');
  if (xml == null) throw new Error('not_a_docx');
  return xmlParagraphs(xml, {
    paragraphTags: new Set(['w:p']),
    // w:delText (tracked deletions) and w:instrText (field codes) are left out
    textTags: new Set(['w:t']),
    spaceTags: new Set(['w:tab', 'w:br', 'w:cr', 'w:ptab']),
    skip: OOXML_SKIP,
  });
};

const relationshipTargets = (xml) => {
  const targets = {};
  if (!xml) return targets;
  walkXml(xml, {
    open(name, attributes) {
      if (name !== 'Relationship') return;
      const id = attributeOf(attributes, 'Id');
      const target = attributeOf(attributes, 'Target');
      if (id && target) targets[id] = target;
    },
  });
  return targets;
};

// Slide files in the order the deck shows them.
const pptxSlidePaths = (container) => {
  const presentation = entryText(container, 'ppt/presentation.xml');
  if (presentation == null) throw new Error('not_a_pptx');
  const targets = relationshipTargets(entryText(container, 'ppt/_rels/presentation.xml.rels'));
  const paths = [];
  walkXml(presentation, {
    open(name, attributes) {
      if (name !== 'p:sldId') return;
      const target = targets[attributeOf(attributes, 'r:id')];
      if (target) paths.push(target.startsWith('/') ? target.slice(1) : `ppt/${target.replace(/^\.\//, '')}`);
    },
  });
  return paths;
};

const pptxParagraphs = (buffer) => {
  const container = openContainer(buffer);
  return pptxSlidePaths(container).flatMap((slidePath, index) => {
    const xml = entryText(container, slidePath);
    if (xml == null) return [];
    return xmlParagraphs(xml, {
      paragraphTags: new Set(['a:p']),
      textTags: new Set(['a:t']),
      spaceTags: new Set(['a:br']),
      skip: OOXML_SKIP,
      section: `Slide ${index + 1}`,
    });
  });
};

/* ───────────── OpenDocument: odt, odp ───────────── */

const ODF_SKIP = new Set([
  'office:annotation', 'office:annotation-end', 'text:tracked-changes', 'text:note-citation',
  'presentation:notes', 'office:automatic-styles', 'office:font-face-decls', 'office:scripts', 'office:forms',
]);

const odfParagraphs = (buffer, { presentation }) => {
  const xml = entryText(openContainer(buffer), 'content.xml');
  if (xml == null) throw new Error('not_an_opendocument_file');
  let slide = 0;
  return xmlParagraphs(xml, {
    paragraphTags: new Set(['text:p', 'text:h']),
    spaceTags: new Set(['text:s', 'text:tab', 'text:line-break']),
    skip: ODF_SKIP,
    sectionOf: (name) => {
      if (!presentation || name !== 'draw:page') return null;
      slide += 1;
      return `Slide ${slide}`;
    },
  });
};

/* ───────────── Word 97-2003 (.doc) ───────────── */

/**
 * Split Word's text stream into paragraphs. \r ends a paragraph, \x07 a
 * table cell or row, \x0c a page or section. Fields (\x13 code \x14
 * result \x15) keep only what they show.
 */
const splitWordText = (text, section = BODY) => {
  const paragraphs = [];
  const fields = [];
  let current = '';
  const flush = () => {
    paragraphs.push(paragraph(section, current));
    current = '';
  };

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x13) fields.push('code');
    else if (code === 0x14) { if (fields.length) fields[fields.length - 1] = 'result'; } else if (code === 0x15) fields.pop();
    else if (fields.includes('code')) { /* field instructions aren't shown */ } else if (code === 0x0D || code === 0x07 || code === 0x0C) flush();
    else if (code === 0x09 || code === 0x0B || code === 0xA0) current += ' ';
    else if (code === 0x1E) current += '-';
    else if (code >= 0x20) current += text[i];
    // Anything else below 0x20 marks a picture, drawing, footnote or
    // comment anchor; it isn't text.
  }
  flush();
  return keepText(paragraphs);
};

// The main document's text through the piece table ([MS-DOC] 2.4.1).
const wordDocumentText = (buffer) => {
  const container = openContainer(buffer);
  const word = entryBytes(container, 'WordDocument');
  if (!word || word.length < 0x1AA || word.readUInt16LE(0) !== 0xA5EC) throw new Error('not_a_word_document');

  const flags = word.readUInt16LE(0x0A);
  if (flags & 0x0100) throw new Error('encrypted');
  const table = entryBytes(container, flags & 0x0200 ? '1Table' : '0Table');
  if (!table) throw new Error('no_table_stream');

  const textLength = word.readInt32LE(0x4C); // ccpText
  const clxStart = word.readUInt32LE(0x1A2); // fcClx
  const clxEnd = clxStart + word.readUInt32LE(0x1A6); // lcbClx
  if (clxEnd > table.length) throw new Error('bad_piece_table');

  let pos = clxStart;
  while (pos < clxEnd && table[pos] === 0x01) pos += 3 + table.readInt16LE(pos + 1); // Prc
  if (table[pos] !== 0x02) throw new Error('bad_piece_table');
  const plc = pos + 5;
  const pieces = (table.readUInt32LE(pos + 1) - 4) / 12;
  if (!Number.isInteger(pieces) || plc + pieces * 12 + 4 > table.length) throw new Error('bad_piece_table');

  let text = '';
  for (let i = 0; i < pieces && text.length < textLength; i += 1) {
    const count = table.readUInt32LE(plc + (i + 1) * 4) - table.readUInt32LE(plc + i * 4);
    const fc = table.readUInt32LE(plc + (pieces + 1) * 4 + i * 8 + 2);
    const offset = fc & 0x3FFFFFFF;
    if (fc & 0x40000000) {
      // 8-bit text, stored at half the offset
      text += cp1252.decode(word.subarray(offset >>> 1, (offset >>> 1) + count));
    } else {
      text += word.toString('utf16le', offset, offset + count * 2);
    }
  }
  return text.slice(0, textLength);
};

const docParagraphs = (buffer) => splitWordText(wordDocumentText(buffer));

/* ───────────── PowerPoint 97-2003 (.ppt) ───────────── */

const RT = {
  DOCUMENT: 0x03E8,
  SLIDE_LIST_WITH_TEXT: 0x0FF0,
  SLIDE_PERSIST_ATOM: 0x03F3,
  TEXT_CHARS_ATOM: 0x0FA0,
  TEXT_BYTES_ATOM: 0x0FA8,
  USER_EDIT_ATOM: 0x0FF5,
  PERSIST_DIRECTORY_ATOM: 0x1772,
};

const recordAt = (stream, offset) => {
  if (offset == null || offset < 0 || offset + 8 > stream.length) return null;
  const head = stream.readUInt16LE(offset);
  const body = offset + 8;
  const end = body + stream.readUInt32LE(offset + 4);
  if (end > stream.length) return null;
  return {
    version: head & 0x0F, instance: head >> 4, type: stream.readUInt16LE(offset + 2), body, end,
  };
};

// Every record inside [start, end), depth first.
const eachRecord = (stream, start, end, visit, depth = 0) => {
  let offset = start;
  while (offset + 8 <= end) {
    const record = recordAt(stream, offset);
    if (!record || record.end > end) return;
    visit(record);
    if (record.version === 0x0F && depth < 32) eachRecord(stream, record.body, record.end, visit, depth + 1);
    offset = record.end;
  }
};

const atomText = (stream, record) => (record.type === RT.TEXT_CHARS_ATOM
  ? stream.toString('utf16le', record.body, record.end)
  : stream.toString('latin1', record.body, record.end));

// Where each saved object lives, newest save first ([MS-PPT] 2.1.2).
const pptPersistDirectory = (stream, currentUser) => {
  const offsets = new Map();
  let documentId = null;
  let editOffset = currentUser && currentUser.length >= 20 ? currentUser.readUInt32LE(16) : null;
  const seen = new Set();

  while (editOffset != null && !seen.has(editOffset)) {
    seen.add(editOffset);
    const edit = recordAt(stream, editOffset);
    if (!edit || edit.type !== RT.USER_EDIT_ATOM) break;
    if (documentId == null) documentId = stream.readUInt32LE(edit.body + 16);
    const directory = recordAt(stream, stream.readUInt32LE(edit.body + 12));
    if (directory && directory.type === RT.PERSIST_DIRECTORY_ATOM) {
      let at = directory.body;
      while (at + 4 <= directory.end) {
        const entry = stream.readUInt32LE(at);
        at += 4;
        const first = entry & 0xFFFFF;
        const count = entry >>> 20;
        for (let k = 0; k < count && at + 4 <= directory.end; k += 1, at += 4) {
          if (!offsets.has(first + k)) offsets.set(first + k, stream.readUInt32LE(at));
        }
      }
    }
    const previous = stream.readUInt32LE(edit.body + 8);
    editOffset = previous || null;
  }
  return { offsets, documentId };
};

const pptParagraphs = (buffer) => {
  const container = openContainer(buffer);
  const stream = entryBytes(container, 'PowerPoint Document');
  if (!stream) throw new Error('not_a_powerpoint_file');
  const { offsets, documentId } = pptPersistDirectory(stream, entryBytes(container, 'Current User'));
  const documentRecord = recordAt(stream, offsets.get(documentId));
  if (!documentRecord || documentRecord.type !== RT.DOCUMENT) throw new Error('no_presentation_document');

  // Slides in order, with the placeholder text kept alongside the list.
  const slides = [];
  eachRecord(stream, documentRecord.body, documentRecord.end, (record) => {
    if (record.type !== RT.SLIDE_LIST_WITH_TEXT || record.instance !== 0) return;
    let slide = null;
    let offset = record.body;
    while (offset + 8 <= record.end) {
      const child = recordAt(stream, offset);
      if (!child) break;
      if (child.type === RT.SLIDE_PERSIST_ATOM) {
        slide = { persistId: stream.readUInt32LE(child.body), texts: [] };
        slides.push(slide);
      } else if (slide && (child.type === RT.TEXT_CHARS_ATOM || child.type === RT.TEXT_BYTES_ATOM)) {
        slide.texts.push(atomText(stream, child));
      }
      offset = child.end;
    }
  });

  return slides.flatMap((slide, index) => {
    // Text boxes that aren't placeholders keep their text in the slide.
    const texts = [...slide.texts];
    const slideRecord = recordAt(stream, offsets.get(slide.persistId));
    if (slideRecord) {
      eachRecord(stream, slideRecord.body, slideRecord.end, (record) => {
        if (record.type === RT.TEXT_CHARS_ATOM || record.type === RT.TEXT_BYTES_ATOM) texts.push(atomText(stream, record));
      });
    }
    const section = `Slide ${index + 1}`;
    return keepText(texts.flatMap((text) => text.split(/[\r\n]/).map((line) => paragraph(section, line.replace(/\x0B/g, ' ')))));
  });
};

/* ───────────── RTF ───────────── */

// Groups whose content isn't body text.
const RTF_SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'fldinst', 'themedata', 'colorschememapping',
  'latentstyles', 'datastore', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'header',
  'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'footnote', 'annotation', 'atnid',
  'atnauthor', 'atnref', 'atndate', 'bkmkstart', 'bkmkend', 'shpinst', 'nonshppict', 'mmathPr', 'pgdsctbl',
  'revtbl', 'filetbl', 'userprops', 'docvar', 'template', 'wgrffmtfilter', 'listtext', 'pntext', 'pntxta', 'pntxtb',
]);
const RTF_BREAKS = new Set(['par', 'sect', 'page', 'row', 'cell', 'nestcell', 'nestrow']);
const RTF_SPACES = new Set(['line', 'tab', 'emspace', 'enspace', 'qmspace']);
const RTF_CHARACTERS = {
  emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”',
};

const rtfParagraphs = (buffer) => {
  const source = buffer.toString('latin1');
  if (!source.startsWith('{\\rtf')) throw new Error('not_an_rtf_file');
  const paragraphs = [];
  let current = '';
  let bytes = [];
  // Per group: skipping its content, and how many characters follow \uN.
  let state = { skip: false, uc: 1 };
  const stack = [];
  let pendingSkip = 0;

  const flushBytes = () => {
    if (!bytes.length) return;
    current += cp1252.decode(Buffer.from(bytes));
    bytes = [];
  };
  const emit = (chars) => {
    if (state.skip) return;
    if (pendingSkip > 0) {
      pendingSkip -= 1;
      return;
    }
    flushBytes();
    current += chars;
  };
  const emitByte = (byte) => {
    if (state.skip) return;
    if (pendingSkip > 0) {
      pendingSkip -= 1;
      return;
    }
    bytes.push(byte);
  };
  const breakParagraph = () => {
    if (state.skip) return;
    flushBytes();
    paragraphs.push(paragraph(BODY, current));
    current = '';
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '{') {
      stack.push(state);
      state = { ...state };
      i += 1;
      // "{\*\dest ...}" is a destination a reader may ignore
      if (source.startsWith('\\*', i)) state.skip = true;
    } else if (ch === '}') {
      flushBytes();
      state = stack.pop() || state;
      pendingSkip = 0;
      i += 1;
    } else if (ch === '\\') {
      const next = source[i + 1];
      if (next === '\'') {
        emitByte(parseInt(source.substr(i + 2, 2), 16));
        i += 4;
      } else if (/[a-zA-Z]/.test(next || '')) {
        const match = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(source.slice(i, i + 40));
        const [whole, word, param] = match;
        i += whole.length;
        if (word === 'u') {
          const code = Number(param);
          emit(String.fromCharCode(code < 0 ? code + 65536 : code));
          pendingSkip = state.uc;
        } else if (word === 'uc') {
          state.uc = Number(param) || 0;
        } else if (RTF_SKIP_DESTINATIONS.has(word)) {
          state.skip = true;
        } else if (RTF_BREAKS.has(word)) {
          breakParagraph();
        } else if (RTF_SPACES.has(word)) {
          emit(' ');
        } else if (RTF_CHARACTERS[word]) {
          emit(RTF_CHARACTERS[word]);
        }
      } else {
        // Control symbols: \\ \{ \} are literal, \~ is a no-break space
        if (next === '\\' || next === '{' || next === '}') emit(next);
        else if (next === '~') emit(' ');
        else if (next === '_') emit('-');
        else if (next === '\n' || next === '\r') breakParagraph();
        i += 2;
      }
    } else {
      if (ch !== '\r' && ch !== '\n') emitByte(ch.charCodeAt(0));
      i += 1;
    }
  }
  breakParagraph();
  return keepText(paragraphs);
};

/* ───────────── Plain text ───────────── */

const txtParagraphs = (buffer) => keepText(buffer.toString('utf8').replace(/^﻿/, '')
  .split(/\r\n|\r|\n/)
  .map((line) => paragraph(BODY, line)));

/* ───────────── By extension ───────────── */

const READERS = {
  docx: docxParagraphs,
  doc: docParagraphs,
  odt: (buffer) => odfParagraphs(buffer, { presentation: false }),
  rtf: rtfParagraphs,
  txt: txtParagraphs,
  pptx: pptxParagraphs,
  ppt: pptParagraphs,
  odp: (buffer) => odfParagraphs(buffer, { presentation: true }),
};

const readParagraphs = (buffer, extension) => {
  const reader = READERS[String(extension || '').toLowerCase()];
  if (!reader) throw new Error('unsupported_type');
  return reader(buffer);
};

export {
  DOCUMENT_EXTENSIONS,
  PRESENTATION_EXTENSIONS,
  splitWordText,
  walkXml,
};

export default {
  readParagraphs,
};
