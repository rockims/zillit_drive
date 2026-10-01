/**
 * Markdown files as text: read for the viewer, saved as a new version,
 * and never written over someone else's newer save.
 */
const { expect } = require('chai');
const sinon = require('sinon');

const DriveTextFile = require('../src/services/v2/driveTextFile').default;
const { isTextFile, MAX_BYTES } = require('../src/services/v2/driveTextFile');
const DriveFileRepository = require('../src/repositories/v2/driveFile').default;
const DriveFileVersionRepository = require('../src/repositories/v2/driveFileVersion').default;
const DriveFileAccessService = require('../src/services/v2/driveFileAccess').default;
const DriveVersionStore = require('../src/services/v2/driveVersionStore').default;
const DriveVersionDiffQueue = require('../src/services/v2/driveVersionDiffQueue').default;
const DriveActivityService = require('../src/services/v2/driveActivity').default;
const DriveDocumentText = require('../src/services/v2/driveDocumentText').default;
const { COMPARABLE_EXTENSIONS } = require('../src/services/v2/driveVersionDiff');
const driveS3 = require('../src/utils/driveS3');
const socketClientModule = require('../src/config/socketClient');

const PROJECT = '64b000000000000000000001';
const USER = '64b000000000000000000aaa';
const FILE = '64b0000000000000000000f1';
const VERSION = '64b0000000000000000000e1';
const OPENED = 1790000000000;

const markdown = (extra = {}) => ({
  _id: FILE,
  project_id: PROJECT,
  file_name: 'Notes.md',
  file_extension: 'md',
  mime_type: 'text/markdown',
  file_size_bytes: 20,
  file_path: 'p1/drive/1790_notes.md',
  attachments: [{ media: 'p1/drive/1790_notes.md', bucket: 'bucket', region: 'ap-south-1' }],
  content_updated_on: OPENED,
  ...extra,
});

const args = (extra = {}) => ({
  user: { _id: USER }, project: { _id: PROJECT }, params: { fileId: FILE }, query: {}, ...extra,
});

const failure = async (run) => {
  try { await run(); } catch (error) { return error; }
  return null;
};

describe('markdown files as text', () => {
  let permissions;
  let file;

  beforeEach(() => {
    file = markdown();
    permissions = { can_view: true, can_edit: true, can_download: true };
    sinon.stub(DriveFileRepository, 'getFile').callsFake(async () => file);
    sinon.stub(DriveFileAccessService, 'resolveFilePermission').callsFake(async () => permissions);
    sinon.stub(driveS3, 'getObjectBuffer').resolves(Buffer.from('﻿# Day 27\n\nCall at 07:00', 'utf8'));
    sinon.stub(DriveVersionStore, 'recordEditorSave').resolves({
      version: { _id: VERSION, version_number: 4, save_type: 'manual' }, savedAt: OPENED + 5000,
    });
    sinon.stub(socketClientModule, 'default');
    sinon.stub(DriveActivityService, 'log').resolves();
    sinon.stub(DriveVersionDiffQueue, 'kick');
  });

  afterEach(() => sinon.restore());

  describe('reading', () => {
    it('returns the text without a byte-order mark, and when it was last saved', async () => {
      const result = await DriveTextFile.getText(args());
      expect(result.content).to.equal('# Day 27\n\nCall at 07:00');
      expect(result.content_time).to.equal(OPENED);
      expect(result.can_edit).to.equal(true);
      expect(result.version_id).to.equal(null);
    });

    it('lets a viewer read but not edit', async () => {
      permissions = { can_view: true, can_edit: false };
      expect((await DriveTextFile.getText(args())).can_edit).to.equal(false);
    });

    it('refuses someone without view access', async () => {
      permissions = { can_view: false };
      expect((await failure(() => DriveTextFile.getText(args()))).message).to.equal('insufficient_permissions');
      permissions = null;
      expect((await failure(() => DriveTextFile.getText(args()))).message).to.equal('insufficient_permissions');
    });

    it('reads a saved version, always read-only', async () => {
      sinon.stub(DriveFileVersionRepository, 'getVersion').resolves({
        _id: VERSION, version_number: 2, s3_key: 'p1/versions/2_notes.md', s3_bucket: 'bucket', s3_region: 'ap-south-1', file_size_bytes: 10,
      });
      const result = await DriveTextFile.getText(args({ query: { version_id: VERSION } }));
      expect(driveS3.getObjectBuffer.firstCall.args[0]).to.include({ key: 'p1/versions/2_notes.md' });
      expect(result.can_edit).to.equal(false);
      expect(result.version_number).to.equal(2);
    });

    it('says so for an unknown or malformed version', async () => {
      sinon.stub(DriveFileVersionRepository, 'getVersion').resolves(null);
      for (const versionId of [VERSION, 'not-an-id']) {
        const error = await failure(() => DriveTextFile.getText(args({ query: { version_id: versionId } })));
        expect(error.message).to.equal('version_not_found');
      }
    });

    it('only opens Markdown, and only up to the size limit', async () => {
      file = markdown({ file_name: 'Budget.xlsx', file_extension: 'xlsx' });
      expect((await failure(() => DriveTextFile.getText(args()))).message).to.equal('file_type_not_text_editable');

      file = markdown({ file_size_bytes: MAX_BYTES + 1 });
      expect((await failure(() => DriveTextFile.getText(args()))).message).to.equal('file_too_large_to_open_as_text');
      expect(driveS3.getObjectBuffer.called).to.equal(false);
    });

    it('knows a Markdown file by either extension', () => {
      expect(isTextFile({ file_name: 'README.markdown' })).to.equal(true);
      expect(isTextFile({ file_name: 'Notes.MD' })).to.equal(true);
      expect(isTextFile({ file_name: 'notes.txt' })).to.equal(false);
    });
  });

  describe('saving', () => {
    const save = (extra = {}) => DriveTextFile.saveText(args({
      query: { content_time: String(OPENED) }, text: '# Day 27\n\nCall at 06:30', ...extra,
    }));

    it('saves the text as a new version and tells open screens', async () => {
      const result = await save();
      const saved = DriveVersionStore.recordEditorSave.firstCall.args[0];
      expect(saved.buffer.toString('utf8')).to.equal('# Day 27\n\nCall at 06:30');
      expect(saved).to.include({ saveType: 'manual', userId: USER, projectId: PROJECT });
      expect(result).to.deep.equal({
        saved: true, content_time: OPENED + 5000, version_id: VERSION, version_number: 4,
      });

      const events = socketClientModule.default.args.map(([, payload]) => payload.event);
      expect(events).to.deep.equal(['drive:file:updated', 'drive:version:created']);
      expect(DriveVersionDiffQueue.kick.calledOnce).to.equal(true);
      expect(DriveActivityService.log.firstCall.args[0].details).to.include({ source: 'text_editor' });
    });

    it('THE RULE: refuses to write over a save made since the file was opened', async () => {
      file = markdown({ content_updated_on: OPENED + 60000 });
      const error = await failure(() => save());
      expect(error.message).to.equal('file_changed_since_opened');
      expect(error.status).to.equal(409);
      expect(DriveVersionStore.recordEditorSave.called).to.equal(false);
    });

    it('overwrites on purpose when no opened-at time is sent', async () => {
      file = markdown({ content_updated_on: OPENED + 60000 });
      expect((await save({ query: {} })).saved).to.equal(true);
    });

    it('treats a garbled opened-at time as a conflict, not as "overwrite"', async () => {
      expect((await failure(() => save({ query: { content_time: 'abc' } }))).message)
        .to.equal('file_changed_since_opened');
    });

    it('reports an unchanged file without announcing anything', async () => {
      DriveVersionStore.recordEditorSave.resolves({ skipped: 'identical' });
      expect(await save()).to.deep.equal({ saved: false, content_time: OPENED });
      expect(socketClientModule.default.called).to.equal(false);
    });

    it('refuses a viewer', async () => {
      permissions = { can_view: true, can_edit: false };
      expect((await failure(() => save())).message).to.equal('no_edit_permission');
      expect(DriveVersionStore.recordEditorSave.called).to.equal(false);
    });

    it('needs a text body: a missing one is an error, an empty one clears the file', async () => {
      expect((await failure(() => save({ text: undefined }))).message).to.equal('file_body_missing');
      expect((await save({ text: '' })).saved).to.equal(true);
      expect(DriveVersionStore.recordEditorSave.firstCall.args[0].buffer.length).to.equal(0);
    });

    it('refuses text over the size limit', async () => {
      const error = await failure(() => save({ text: 'a'.repeat(MAX_BYTES + 1) }));
      expect(error.message).to.equal('file_too_large_to_save_as_text');
    });
  });

  describe('version history', () => {
    it('compares Markdown versions line by line, like plain text', () => {
      expect(COMPARABLE_EXTENSIONS.has('md')).to.equal(true);
      expect(COMPARABLE_EXTENSIONS.has('markdown')).to.equal(true);
      const paragraphs = DriveDocumentText.readParagraphs(Buffer.from('# Day 27\n\nCall at 07:00\n'), 'md');
      expect(paragraphs.map((paragraph) => paragraph.text)).to.deep.equal(['# Day 27', 'Call at 07:00']);
    });
  });
});
