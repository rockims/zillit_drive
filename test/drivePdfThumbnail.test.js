/**
 * PDF thumbnails: page 1 rendered by the editor server, scaled to 320px
 * wide in the page's own shape, stored beside the PDF and attached to it.
 */
const { expect } = require('chai');
const sinon = require('sinon');
const axios = require('axios');

const DrivePdfThumbnail = require('../src/services/v2/drivePdfThumbnail').default;
const { pngSize, thumbnailSizeFor, thumbnailKeyFor } = require('../src/services/v2/drivePdfThumbnail');
const DriveFileRepository = require('../src/repositories/v2/driveFile').default;
const driveS3 = require('../src/utils/driveS3');
const socketClientModule = require('../src/config/socketClient');

// The start of a PNG: signature and an IHDR with this size.
const png = (width, height) => {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
};

const PROJECT = '64b000000000000000000001';
const USER = '64b000000000000000000aaa';

const pdf = (extra = {}) => ({
  _id: '64b0000000000000000000f1',
  project_id: PROJECT,
  folder_id: '64b0000000000000000000d1',
  file_name: 'Call sheet day 27.pdf',
  file_extension: 'pdf',
  mime_type: 'application/pdf',
  file_size_bytes: 400000,
  file_path: 'p1/drive/1790_call-sheet.pdf',
  attachments: [{ media: 'p1/drive/1790_call-sheet.pdf', bucket: 'bucket', region: 'ap-south-1', thumbnail: '' }],
  created_by: USER,
  ...extra,
});

describe('Drive PDF thumbnails', () => {
  describe('sizes and names', () => {
    it('reads a PNG\'s size and rejects anything else', () => {
      expect(pngSize(png(816, 1056))).to.deep.equal({ width: 816, height: 1056 });
      expect(pngSize(Buffer.from('<html>error</html>'))).to.equal(null);
    });

    it('keeps the page\'s shape at 320px wide, within sensible heights', () => {
      expect(thumbnailSizeFor({ width: 816, height: 1056 })).to.deep.equal({ width: 320, height: 414 }); // letter
      expect(thumbnailSizeFor({ width: 1058, height: 595 })).to.deep.equal({ width: 320, height: 180 }); // slide
      expect(thumbnailSizeFor({ width: 100, height: 5000 }).height).to.equal(480);
      expect(thumbnailSizeFor({ width: 5000, height: 100 }).height).to.equal(120);
    });

    it('stores the thumbnail beside the PDF', () => {
      expect(thumbnailKeyFor('p1/drive/1790_call-sheet.pdf')).to.equal('p1/drive/1790_call-sheet-thumb.png');
      expect(thumbnailKeyFor('p1/drive.v2/no-extension')).to.equal('p1/drive.v2/no-extension-thumb.png');
    });

    it('recognises PDFs by type, extension or name', () => {
      expect(DrivePdfThumbnail.isPdfFile(pdf())).to.equal(true);
      expect(DrivePdfThumbnail.isPdfFile({ file_name: 'scan.PDF' })).to.equal(true);
      expect(DrivePdfThumbnail.isPdfFile({ attachments: [{ content_type: 'application', content_subtype: 'pdf' }] })).to.equal(true);
      expect(DrivePdfThumbnail.isPdfFile({ file_name: 'budget.xlsx', mime_type: 'application/vnd.ms-excel' })).to.equal(false);
    });
  });

  describe('making one', () => {
    let sandbox;
    let post;
    let send;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      sandbox.stub(driveS3, 'getObjectBuffer').resolves(Buffer.from('%PDF-1.7'));
      send = sandbox.stub().resolves({});
      sandbox.stub(driveS3, 'getS3Client').returns({ send });
      post = sandbox.stub(axios, 'post');
      post.onFirstCall().resolves({ data: png(816, 1056) });
      post.onSecondCall().resolves({ data: png(320, 414) });
      sandbox.stub(DriveFileRepository, 'updateFileDocument').callsFake(async ({ data }) => ({
        ...pdf(), attachments: [{ ...pdf().attachments[0], thumbnail: data['attachments.0.thumbnail'] }],
      }));
      sandbox.stub(socketClientModule, 'default');
      sandbox.stub(console, 'log');
      sandbox.stub(console, 'error');
    });

    afterEach(() => sandbox.restore());

    it('renders page 1, scales it to the page\'s shape, stores and attaches it', async () => {
      const key = await DrivePdfThumbnail.generatePdfThumbnail({ projectId: PROJECT, file: pdf(), notifyUserIds: [USER] });

      expect(key).to.equal('p1/drive/1790_call-sheet-thumb.png');
      expect(post.firstCall.args[0]).to.match(/\/cool\/convert-to\/png$/);
      const scaled = post.secondCall.args[1].getBuffer().toString();
      expect(scaled).to.contain('"PixelWidth":{"type":"long","value":"320"}');
      expect(scaled).to.contain('"PixelHeight":{"type":"long","value":"414"}');

      const put = send.firstCall.args[0].input;
      expect(put).to.include({ Bucket: 'bucket', Key: key, ContentType: 'image/png' });

      // Only the thumbnail changes; "Date modified" stays as it was
      expect(DriveFileRepository.updateFileDocument.firstCall.args[0].data).to.deep.equal({ 'attachments.0.thumbnail': key });

      const [, emit] = socketClientModule.default.firstCall.args;
      expect(emit.event).to.equal('drive:file:updated');
      expect(emit.room).to.deep.equal([USER]);
      expect(emit.data.file.attachments[0].thumbnail).to.equal(key);
    });

    it('uses the first render as it is when the page is already small', async () => {
      post.onFirstCall().resolves({ data: png(300, 200) });
      await DrivePdfThumbnail.generatePdfThumbnail({ projectId: PROJECT, file: pdf() });
      expect(post.calledOnce).to.equal(true);
      expect(socketClientModule.default.called).to.equal(false); // nobody to tell
    });

    it('leaves alone other files, thumbnails the app sent, and very large PDFs', async () => {
      const skipped = [
        pdf({ file_name: 'budget.xlsx', file_extension: 'xlsx', mime_type: 'application/vnd.ms-excel' }),
        pdf({ attachments: [{ ...pdf().attachments[0], thumbnail: 'from-the-app.jpg' }] }),
        pdf({ file_size_bytes: 80 * 1024 * 1024 }),
      ];
      // eslint-disable-next-line no-restricted-syntax
      for (const file of skipped) {
        // eslint-disable-next-line no-await-in-loop
        expect(await DrivePdfThumbnail.generatePdfThumbnail({ projectId: PROJECT, file })).to.equal(null);
      }
      expect(post.called).to.equal(false);
    });

    it('never throws: a refusal from the editor server just means no thumbnail', async () => {
      post.onFirstCall().rejects(Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } }));
      expect(await DrivePdfThumbnail.generatePdfThumbnail({ projectId: PROJECT, file: pdf() })).to.equal(null);
      expect(send.called).to.equal(false);
      expect(console.error.firstCall.args[0]).to.match(/pdf_thumbnail_failed.*status=403/);
    });

    it('works through queued uploads one at a time', async () => {
      const order = [];
      let running = 0;
      sandbox.stub(DrivePdfThumbnail, 'generatePdfThumbnail').callsFake(async ({ file }) => {
        running += 1;
        expect(running).to.equal(1);
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        order.push(file._id);
        running -= 1;
      });
      expect(DrivePdfThumbnail.queuePdfThumbnail({ projectId: PROJECT, file: pdf({ _id: 'a' }) })).to.equal(true);
      expect(DrivePdfThumbnail.queuePdfThumbnail({ projectId: PROJECT, file: pdf({ _id: 'b' }) })).to.equal(true);
      expect(DrivePdfThumbnail.queuePdfThumbnail({ projectId: PROJECT, file: { file_name: 'x.docx' } })).to.equal(false);
      await new Promise((resolve) => { setTimeout(resolve, 40); });
      expect(order).to.deep.equal(['a', 'b']);
    });
  });
});
