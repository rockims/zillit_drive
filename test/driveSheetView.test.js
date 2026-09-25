/**
 * Read-only spreadsheets open at the top: the copy served to a read-only
 * editor has the last saver's cursor and scroll position reset.
 */
const { expect } = require('chai');
const sinon = require('sinon');
const XLSX = require('xlsx');

const DriveSheetView = require('../src/services/v2/driveSheetView').default;
const { stripSheetPosition, MAX_BYTES } = require('../src/services/v2/driveSheetView');
const DriveWopiService = require('../src/services/v2/driveWopi').default;
const DriveFileRepository = require('../src/repositories/v2/driveFile').default;
const DriveFileVersionRepository = require('../src/repositories/v2/driveFileVersion').default;
const DriveEditPresenceService = require('../src/services/v2/driveEditPresence').default;
const driveS3 = require('../src/utils/driveS3');

const SAVED_VIEW = '<sheetViews><sheetView tabSelected="1" topLeftCell="A18" zoomScale="120" workbookViewId="0">'
  + '<selection activeCell="E26" sqref="E26"/></sheetView></sheetViews>';

// A workbook whose sheets were saved with the given <sheetViews> XML.
const workbook = (viewsBySheet) => {
  const book = XLSX.utils.book_new();
  Object.keys(viewsBySheet).forEach((name) => {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Scene', 'Day'], ['12A', 3]]), name);
  });
  const container = XLSX.CFB.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  Object.values(viewsBySheet).forEach((views, index) => {
    const at = container.FullPaths.findIndex((p) => p.endsWith(`/xl/worksheets/sheet${index + 1}.xml`));
    const entry = container.FileIndex[at];
    const xml = Buffer.from(entry.content).toString('utf8').replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, views);
    entry.content = Buffer.from(xml, 'utf8');
    entry.size = entry.content.length;
  });
  return Buffer.from(XLSX.CFB.write(container, { fileType: 'zip', type: 'buffer', compression: true }));
};

const sheetXml = (buffer, number) => {
  const container = XLSX.CFB.read(buffer, { type: 'buffer' });
  const at = container.FullPaths.findIndex((p) => p.endsWith(`/xl/worksheets/sheet${number}.xml`));
  return Buffer.from(container.FileIndex[at].content).toString('utf8');
};

describe('Drive read-only spreadsheets open at the top', () => {
  describe('one sheet\'s view', () => {
    it('drops the saved cursor and scroll position, keeping the rest of the view', () => {
      expect(stripSheetPosition(`<worksheet>${SAVED_VIEW}<sheetData/></worksheet>`)).to.equal(
        '<worksheet><sheetViews><sheetView tabSelected="1" zoomScale="120" workbookViewId="0"></sheetView></sheetViews><sheetData/></worksheet>',
      );
    });

    it('keeps frozen rows and columns but scrolls their pane back to the top', () => {
      const frozen = '<sheetViews><sheetView workbookViewId="0">'
        + '<pane xSplit="2" ySplit="1" topLeftCell="C480" activePane="bottomRight" state="frozen"/>'
        + '<selection pane="topRight" activeCell="C1" sqref="C1"/>'
        + '<selection pane="bottomRight" activeCell="D500" sqref="D500"/>'
        + '</sheetView></sheetViews>';
      expect(stripSheetPosition(frozen)).to.equal(
        '<sheetViews><sheetView workbookViewId="0">'
        + '<pane xSplit="2" ySplit="1" topLeftCell="C2" activePane="bottomRight" state="frozen"/>'
        + '</sheetView></sheetViews>',
      );
    });

    it('leaves a plain split pane alone, and XML without a view unchanged', () => {
      const split = '<sheetViews><sheetView workbookViewId="0"><pane xSplit="2400" topLeftCell="H1" state="split"/></sheetView></sheetViews>';
      expect(stripSheetPosition(split)).to.equal(split);
      expect(stripSheetPosition('<worksheet><sheetData/></worksheet>')).to.equal('<worksheet><sheetData/></worksheet>');
    });

    it('never touches cells outside the view, even ones that look alike', () => {
      const xml = `<worksheet>${SAVED_VIEW}<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>topLeftCell="A18"</t></is></c></row></sheetData></worksheet>`;
      expect(stripSheetPosition(xml)).to.contain('<t>topLeftCell="A18"</t>');
    });
  });

  describe('a whole workbook', () => {
    it('resets every sheet and keeps the data', () => {
      const original = workbook({ Schedule: SAVED_VIEW, Crew: SAVED_VIEW.replace('E26', 'B37') });
      const reset = DriveSheetView.resetSavedPosition(original);

      [1, 2].forEach((number) => {
        expect(sheetXml(reset, number)).not.to.match(/activeCell|topLeftCell/);
        expect(sheetXml(reset, number)).to.contain('zoomScale="120"');
      });
      const before = XLSX.read(original, { type: 'buffer' });
      const after = XLSX.read(reset, { type: 'buffer' });
      expect(after.SheetNames).to.deep.equal(['Schedule', 'Crew']);
      expect(XLSX.utils.sheet_to_json(after.Sheets.Crew, { header: 1 }))
        .to.deep.equal(XLSX.utils.sheet_to_json(before.Sheets.Crew, { header: 1 }));
    });

    it('serves a file already at the top as it is', () => {
      const original = workbook({ Schedule: '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' });
      expect(DriveSheetView.resetSavedPosition(original)).to.equal(original);
    });

    it('serves anything it can\'t read as it is', () => {
      const notAWorkbook = Buffer.from('this is not a zip');
      const quiet = sinon.stub(console, 'error');
      try {
        expect(DriveSheetView.resetSavedPosition(notAWorkbook)).to.equal(notAWorkbook);
      } finally {
        quiet.restore();
      }
    });

    it('only handles xlsx and xlsm up to the size limit', () => {
      expect(DriveSheetView.canReset({ extension: 'xlsx', sizeBytes: 1000 })).to.equal(true);
      expect(DriveSheetView.canReset({ extension: 'XLSM' })).to.equal(true);
      expect(DriveSheetView.canReset({ extension: 'xlsx', sizeBytes: MAX_BYTES + 1 })).to.equal(false);
      ['xls', 'ods', 'csv', 'docx', ''].forEach((extension) => {
        expect(DriveSheetView.canReset({ extension, sizeBytes: 1000 })).to.equal(false);
      });
    });
  });

  describe('WOPI GetFile', () => {
    const PROJECT = '64b000000000000000000001';
    const USER = '64b000000000000000000aaa';
    const FILE_ID = '64b0000000000000000000f1';
    const VERSION_ID = '64b0000000000000000000a2';
    const stored = workbook({ Schedule: SAVED_VIEW });
    let sandbox;
    let sent;

    const response = () => ({
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      end(body) { sent = body; },
    });

    const getFile = (token, fileId = FILE_ID) => {
      const res = response();
      return DriveWopiService.getFileContents({ params: { fileId }, query: { access_token: token }, res })
        .then(() => res);
    };

    const liveToken = (canEdit) => DriveWopiService.generateAccessToken({
      user: { _id: USER }, project: { _id: PROJECT }, file: { _id: FILE_ID }, canEdit, canDownload: true,
    }).token;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      sent = undefined;
      sandbox.stub(DriveEditPresenceService, 'touch').resolves();
      sandbox.stub(DriveFileRepository, 'getFile').resolves({
        _id: FILE_ID,
        project_id: PROJECT,
        file_name: 'Schedule.xlsx',
        file_extension: 'xlsx',
        file_size_bytes: stored.length,
        file_path: 'drive/schedule.xlsx',
      });
      sandbox.stub(driveS3, 'getObjectBuffer').resolves(stored);
    });

    afterEach(() => sandbox.restore());

    it('gives a view-only user the file opened at the top', async () => {
      const res = await getFile(liveToken(false));
      expect(sheetXml(sent, 1)).not.to.contain('activeCell');
      expect(res.headers['Content-Length']).to.equal(sent.length);
    });

    it('opens an old version at the top too', async () => {
      sandbox.stub(DriveFileVersionRepository, 'getVersion').resolves({
        _id: VERSION_ID, file_id: FILE_ID, s3_key: 'drive/v1.xlsx', s3_bucket: 'bucket', s3_region: 'us-east-1', file_size_bytes: stored.length,
      });
      const { token } = DriveWopiService.generateVersionAccessToken({
        user: { _id: USER }, project: { _id: PROJECT }, file: { _id: FILE_ID }, version: { _id: VERSION_ID },
      });
      await getFile(token, `${FILE_ID}_v${VERSION_ID}`);
      expect(driveS3.getObjectBuffer.firstCall.args[0]).to.include({ key: 'drive/v1.xlsx' });
      expect(sheetXml(sent, 1)).not.to.contain('activeCell');
    });

    it('streams the stored file untouched to an editor', async () => {
      const pipe = sinon.spy();
      sandbox.stub(driveS3, 'getS3Client').returns({ send: sinon.stub().resolves({ ContentLength: stored.length, Body: { pipe } }) });
      await getFile(liveToken(true));
      expect(driveS3.getObjectBuffer.called).to.equal(false);
      expect(pipe.calledOnce).to.equal(true);
    });
  });
});
