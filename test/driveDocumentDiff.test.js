/**
 * Version comparison for documents and presentations — paragraph by
 * paragraph, on files written by the editor's own engine.
 *
 * test/fixtures/documents holds one before/after pair per format, made by
 * converting the same two drafts with the editor: the after draft changes
 * a time, drops a list item, edits a table cell and adds a paragraph (the
 * deck: edits a line, inserts a slide, edits a line on the next slide).
 */
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const XLSX = require('xlsx');

const DriveDocumentText = require('../src/services/v2/driveDocumentText').default;
const { splitWordText } = require('../src/services/v2/driveDocumentText');
const DriveDocumentDiff = require('../src/services/v2/driveDocumentDiff').default;
const { alignParagraphs, focusEdit } = require('../src/services/v2/driveDocumentDiff');
const { diffVersionBuffers } = require('../src/services/v2/driveVersionDiff');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'documents', name));
const read = (extension, draft = 'after') => DriveDocumentText.readParagraphs(fixture(`${draft}.${extension}`), extension);
const diff = (extension) => diffVersionBuffers(fixture(`before.${extension}`), fixture(`after.${extension}`), { extension });

// A .docx holding just this body XML.
const docx = (body) => {
  const container = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(container, 'word/document.xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="w" xmlns:mc="mc"><w:body>'
    + `${body}</w:body></w:document>`,
  ));
  return Buffer.from(XLSX.CFB.write(container, { fileType: 'zip', type: 'buffer' }));
};

const SCHEDULE = [
  'Shooting schedule',
  'Day 1 starts at the café on Marine Drive — call time 7:00 sharp.',
  'Budget ₹4,50,000 approved by “Priya”. Second line of the same paragraph.',
  'Camera: ARRI Alexa',
  'Grip: dolly',
  'Scene',
  'Location',
  '12A',
  'Studio 4',
  'See Zillit for the call sheet.',
  'Wrap by 19:00, no overtime.',
];

const DECK = [
  ['Slide 1', 'Pitch deck'],
  ['Slide 1', 'Logline: a heist on a film set'],
  ['Slide 1', 'Budget ₹2.5 crore'],
  ['Slide 2', 'Locations'],
  ['Slide 2', 'Goa and Mumbai'],
  ['Slide 3', 'Cast'],
  ['Slide 3', 'Lead: Aarav'],
  ['Slide 3', 'Support: open call'],
];

describe('Drive document and presentation comparison', () => {
  describe('reading the text', () => {
    ['docx', 'doc', 'odt', 'rtf'].forEach((extension) => {
      it(`reads a .${extension} paragraph by paragraph, table cells and link text included`, () => {
        const paragraphs = read(extension);
        expect(paragraphs.map((p) => p.text)).to.deep.equal(SCHEDULE);
        expect(new Set(paragraphs.map((p) => p.section))).to.deep.equal(new Set(['Document']));
      });
    });

    ['pptx', 'ppt', 'odp'].forEach((extension) => {
      it(`reads a .${extension} slide by slide, in the order the deck shows them`, () => {
        expect(read(extension).map((p) => [p.section, p.text])).to.deep.equal(DECK);
      });
    });

    it('reads a .txt line by line', () => {
      expect(read('txt')[4]).to.deep.equal({ section: 'Document', text: '• Camera: ARRI Alexa' });
    });

    it('leaves out tracked deletions, field codes and the duplicate copy of a text box', () => {
      const paragraphs = DriveDocumentText.readParagraphs(docx(
        '<w:p><w:r><w:t>Call time </w:t></w:r><w:del><w:r><w:delText>6:30</w:delText></w:r></w:del>'
        + '<w:ins><w:r><w:t>7:00</w:t></w:r></w:ins></w:p>'
        + '<w:p><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:t>Page 2</w:t></w:r></w:p>'
        + '<w:p><w:r><mc:AlternateContent><mc:Choice><w:txbxContent><w:p><w:r><w:t>In the box</w:t></w:r></w:p>'
        + '</w:txbxContent></mc:Choice><mc:Fallback><w:txbxContent><w:p><w:r><w:t>In the box</w:t></w:r></w:p>'
        + '</w:txbxContent></mc:Fallback></mc:AlternateContent></w:r><w:r><w:t>Next to the box</w:t></w:r></w:p>'
        + '<w:p/><w:p><w:r><w:t xml:space="preserve">  Tom &amp; Jerry&#8217;s  </w:t></w:r></w:p>',
      ), 'docx');
      expect(paragraphs.map((p) => p.text)).to.deep.equal([
        'Call time 7:00', 'Page 2', 'In the box', 'Next to the box', 'Tom & Jerry’s',
      ]);
    });

    it('splits Word\'s text stream at paragraphs and table cells, showing fields as displayed', () => {
      const text = 'Title\r\x13 HYPERLINK "https://zillit.com" \x14Zillit\x15 site\rA1\x07B1\x07\x07\x01Caption\x0bline two\r';
      expect(splitWordText(text).map((p) => p.text)).to.deep.equal(['Title', 'Zillit site', 'A1', 'B1', 'Caption line two']);
    });

    it('reads unicode and skips non-body groups in RTF', () => {
      const rtf = Buffer.from('{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}{\\*\\generator Writer;}'
        + '{\\info{\\title Secret}}Budget \\u8377\\\'3f4 lakh\\par Caf\\\'e9 {\\field{\\*\\fldinst HYPERLINK "x"}{\\fldrslt link}}\\par}', 'latin1');
      expect(DriveDocumentText.readParagraphs(rtf, 'rtf').map((p) => p.text)).to.deep.equal(['Budget ₹4 lakh', 'Café link']);
    });

    it('refuses types it doesn\'t read and files that aren\'t what they claim', () => {
      expect(() => DriveDocumentText.readParagraphs(Buffer.from('x'), 'pdf')).to.throw('unsupported_type');
      expect(() => DriveDocumentText.readParagraphs(fixture('after.odt'), 'docx')).to.throw('not_a_docx');
      expect(() => DriveDocumentText.readParagraphs(Buffer.from('plain'), 'doc')).to.throw();
    });
  });

  describe('what changed', () => {
    ['docx', 'doc', 'odt', 'rtf'].forEach((extension) => {
      it(`finds the edit, the removed item, the changed cell and the new paragraph in a .${extension}`, () => {
        const result = diff(extension);
        expect(result.total).to.equal(4);
        expect(result.sheets).to.have.length(1);
        expect(result.sheets[0]).to.include({ name: 'Document', status: 'changed', total: 4 });
        expect(result.sheets[0].changes).to.deep.equal([
          {
            c: '2', r: 1, col: 0, k: 'changed',
            b: 'Day 1 starts at the café on Marine Drive — call time 6:30 sharp.',
            a: 'Day 1 starts at the café on Marine Drive — call time 7:00 sharp.',
          },
          {
            c: '5', r: 4, col: 0, k: 'removed', b: 'Lights: 12 Kinos', a: '',
          },
          {
            c: '9', r: 8, col: 0, k: 'changed', b: 'Beach', a: 'Studio 4',
          },
          {
            c: '11', r: 10, col: 0, k: 'added', b: '', a: 'Wrap by 19:00, no overtime.',
          },
        ]);
      });
    });

    ['pptx', 'ppt', 'odp'].forEach((extension) => {
      it(`groups the changes in a .${extension} by slide`, () => {
        const result = diff(extension);
        expect(result.sheets.map((s) => [s.name, s.changes.map((c) => [c.k, c.a])])).to.deep.equal([
          ['Slide 1', [['changed', 'Budget ₹2.5 crore']]],
          ['Slide 2', [['added', 'Locations'], ['added', 'Goa and Mumbai']]],
          ['Slide 3', [['changed', 'Lead: Aarav']]],
        ]);
      });
    });

    it('reports nothing when only the formatting changed', () => {
      const plain = docx('<w:p><w:r><w:t>Call time 7:00</w:t></w:r></w:p>');
      const bold = docx('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Call time 7:00</w:t></w:r></w:p>');
      expect(DriveDocumentDiff.diffDocumentBuffers(plain, bold, { extension: 'docx' })).to.deep.equal({
        total: 0, truncated: false, sheets: [],
      });
    });

    it('keeps a capped number of changes but counts them all', () => {
      const lines = (prefix) => Buffer.from(Array.from({ length: 30 }, (_, i) => `${prefix} line ${i}`).join('\n'));
      const result = DriveDocumentDiff.diffDocumentBuffers(lines('old'), lines('new'), { extension: 'txt', maxChanges: 10 });
      expect(result.total).to.equal(30);
      expect(result.truncated).to.equal(true);
      expect(result.sheets[0].changes).to.have.length(10);
    });

    it('still reads spreadsheets cell by cell, and treats a missing type as a spreadsheet', () => {
      const book = (value) => {
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[value]]), 'S');
        return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      };
      [{ extension: 'xlsx' }, {}].forEach((options) => {
        const [change] = diffVersionBuffers(book('a'), book('b'), options).sheets[0].changes;
        expect(change).to.include({ c: 'A1', k: 'changed' });
      });
      expect(() => diffVersionBuffers(book('a'), book('b'), { extension: 'pdf' })).to.throw('unsupported_type');
    });
  });

  describe('lining paragraphs up', () => {
    it('matches what stayed, so an insertion or deletion doesn\'t shift everything after it', () => {
      const steps = alignParagraphs(['a', 'b', 'c', 'd'], ['a', 'x', 'b', 'd']);
      expect(steps).to.deep.equal([
        { type: 'same', i: 0, j: 0 },
        { type: 'added', j: 1 },
        { type: 'same', i: 1, j: 2 },
        { type: 'removed', i: 2 },
        { type: 'same', i: 3, j: 3 },
      ]);
    });

    it('pairs an edited paragraph with its new text among unrelated additions', () => {
      const before = Buffer.from('Intro\nThe crew meets at the café at six\nOutro');
      const after = Buffer.from('Intro\nBrand new paragraph\nThe crew meets at the studio at six\nAnother new one\nOutro');
      const [section] = DriveDocumentDiff.diffDocumentBuffers(before, after, { extension: 'txt' }).sheets;
      expect(section.changes.map((c) => c.k)).to.deep.equal(['added', 'changed', 'added']);
      expect(section.changes[1]).to.include({ b: 'The crew meets at the café at six', a: 'The crew meets at the studio at six' });
    });

    it('trims a long edited paragraph to the edit and a little text either side', () => {
      const start = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.';
      const end = 'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo.';
      const { b, a } = focusEdit(`${start} Call at six. ${end}`, `${start} Call at seven. ${end}`);
      expect(b).to.equal('…elit, sed do eiusmod tempor incididunt ut labore. Call at six. Ut enim ad minim veniam, quis nostrud exercitation ullamco…');
      expect(a).to.equal('…elit, sed do eiusmod tempor incididunt ut labore. Call at seven. Ut enim ad minim veniam, quis nostrud exercitation ullamco…');
    });
  });
});
