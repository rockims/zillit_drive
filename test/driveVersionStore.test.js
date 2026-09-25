/**
 * Version store — what a save from the editor writes.
 *
 *  - the version is labelled with the person who saved, not the next one
 *  - saves the user didn't make, and identical content, write nothing
 *  - the first tracked save records the existing content as a baseline
 *  - saves under 30 minutes apart share a session
 *  - numbers come from the file's atomic counter
 *  - restore keeps the pre-restore content and fails loudly on S3 errors
 */
const { expect } = require('chai');
const sinon = require('sinon');
const crypto = require('crypto');

const DriveVersionStore = require('../src/services/v2/driveVersionStore').default;
const DriveFileRepository = require('../src/repositories/v2/driveFile').default;
const DriveFileVersionRepository = require('../src/repositories/v2/driveFileVersion').default;
const DriveEditPresenceService = require('../src/services/v2/driveEditPresence').default;
const driveS3 = require('../src/utils/driveS3');

const PROJECT = '64b000000000000000000001';
const SAVER = '64b000000000000000000aaa';
const UPLOADER = '64b000000000000000000bbb';
const FILE_ID = '64b0000000000000000000f1';

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const liveFile = (extra = {}) => ({
  _id: FILE_ID,
  project_id: PROJECT,
  file_name: 'Budget.xlsx',
  file_extension: 'xlsx',
  file_size_bytes: 1000,
  mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  file_path: `${PROJECT}/drive/1_budget.xlsx`,
  attachments: [{ media: `${PROJECT}/drive/1_budget.xlsx`, bucket: 'bucket-a', region: 'ap-south-1' }],
  created_by: UPLOADER,
  uploaded_by: UPLOADER,
  created_on: 1000,
  updated_on: 5000,
  content_updated_on: null,
  content_sha256: '',
  current_version_id: null,
  ...extra,
});

describe('Drive version store', () => {
  let sandbox;
  let s3Send;
  let created;
  let seq;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    s3Send = sandbox.stub().resolves({});
    sandbox.stub(driveS3, 'getS3Client').returns({ send: s3Send });
    created = [];
    seq = 0;
    sandbox.stub(DriveFileRepository, 'raiseVersionSeqFloor').resolves();
    sandbox.stub(DriveFileRepository, 'incrementVersionSeq').callsFake(async () => { seq += 1; return seq; });
    sandbox.stub(DriveFileRepository, 'updateFile').resolves();
    sandbox.stub(DriveFileVersionRepository, 'getLatestVersion').resolves(null);
    sandbox.stub(DriveFileVersionRepository, 'getVersion').resolves(null);
    sandbox.stub(DriveFileVersionRepository, 'createVersion').callsFake(async ({ data }) => {
      const record = { _id: `ver-${created.length + 1}`, ...data };
      created.push(record);
      return record;
    });
    sandbox.stub(DriveEditPresenceService, 'editorsSince').callsFake(async ({ include }) => [include, UPLOADER]);
  });

  afterEach(() => sandbox.restore());

  describe('recordEditorSave', () => {
    it('writes nothing when the editor says the user made no change', async () => {
      const result = await DriveVersionStore.recordEditorSave({
        file: liveFile(), projectId: PROJECT, userId: SAVER, buffer: Buffer.from('x'), modifiedByUser: false,
      });
      expect(result).to.deep.equal({ skipped: 'not_modified_by_user' });
      expect(s3Send.called).to.equal(false);
      expect(DriveFileVersionRepository.createVersion.called).to.equal(false);
    });

    it('writes nothing when the content is identical to the current version', async () => {
      const buffer = Buffer.from('same bytes');
      const result = await DriveVersionStore.recordEditorSave({
        file: liveFile({ content_sha256: sha(buffer) }), projectId: PROJECT, userId: SAVER, buffer,
      });
      expect(result).to.deep.equal({ skipped: 'identical' });
      expect(s3Send.called).to.equal(false);
    });

    it('records the upload as a baseline, then the save labelled with the saver', async () => {
      const buffer = Buffer.from('new content');
      const { version } = await DriveVersionStore.recordEditorSave({
        file: liveFile(), projectId: PROJECT, userId: SAVER, buffer, saveType: 'autosave',
      });

      expect(created).to.have.length(2);
      const [baseline] = created;
      expect(baseline).to.include({
        version_number: 1, save_type: 'upload', saved_by: UPLOADER, saved_at: 1000,
      });
      expect(version).to.include({
        version_number: 2,
        save_type: 'autosave',
        saved_by: SAVER,
        uploaded_by: SAVER,
        content_sha256: sha(buffer),
        file_size_bytes: buffer.length,
      });
      expect(version.editors).to.deep.equal([SAVER, UPLOADER]);
      // A spreadsheet with a previous version gets compared
      expect(version.changes).to.deep.equal({ status: 'pending', reason: '' });
    });

    it('keeps each version in its own S3 object and updates the live key from it', async () => {
      // An existing current version, so no baseline copy happens first
      DriveFileVersionRepository.getVersion.resolves({ _id: 'ver-0', saved_at: Date.now(), save_type: 'autosave' });
      await DriveVersionStore.recordEditorSave({
        file: liveFile({ current_version_id: 'ver-0' }),
        projectId: PROJECT,
        userId: SAVER,
        buffer: Buffer.from('abc'),
      });
      expect(s3Send.callCount).to.equal(2);

      const put = s3Send.args.map(([cmd]) => cmd).find((cmd) => cmd.constructor.name === 'PutObjectCommand');
      const copy = s3Send.args.map(([cmd]) => cmd).find((cmd) => cmd.constructor.name === 'CopyObjectCommand');
      expect(put.input.Key).to.match(new RegExp(`^${PROJECT}/drive/versions/${FILE_ID}/\\d+-\\d+\\.xlsx$`));
      expect(copy.input.Key).to.equal(`${PROJECT}/drive/1_budget.xlsx`);
      expect(copy.input.CopySource).to.equal(`bucket-a/${put.input.Key}`);
    });

    it('updates the file with the saver, content time, hash and current version', async () => {
      const buffer = Buffer.from('v2');
      const { version, savedAt } = await DriveVersionStore.recordEditorSave({
        file: liveFile(), projectId: PROJECT, userId: SAVER, buffer,
      });
      const { data } = DriveFileRepository.updateFile.lastCall.args[0];
      expect(data).to.include({
        updated_by: SAVER,
        content_updated_on: savedAt,
        content_sha256: sha(buffer),
        current_version_id: version._id,
        file_size_bytes: 2,
      });
      expect(data.attachments[0].file_size_bytes).to.equal(2);
    });

    it('continues the session for a save soon after the previous one', async () => {
      DriveFileVersionRepository.getVersion.resolves({
        _id: 'ver-7', file_id: FILE_ID, saved_at: Date.now() - 5 * 60 * 1000, save_type: 'autosave', session_id: 'session-abc',
      });
      const { version } = await DriveVersionStore.recordEditorSave({
        file: liveFile({ current_version_id: 'ver-7' }), projectId: PROJECT, userId: SAVER, buffer: Buffer.from('z'), saveType: 'autosave',
      });
      expect(version.session_id).to.equal('session-abc');
    });

    it('starts a new session after a long gap', async () => {
      DriveFileVersionRepository.getVersion.resolves({
        _id: 'ver-7', file_id: FILE_ID, saved_at: Date.now() - 45 * 60 * 1000, save_type: 'autosave', session_id: 'session-abc',
      });
      const { version } = await DriveVersionStore.recordEditorSave({
        file: liveFile({ current_version_id: 'ver-7' }), projectId: PROJECT, userId: SAVER, buffer: Buffer.from('z'), saveType: 'autosave',
      });
      expect(version.session_id).to.not.equal('session-abc');
      expect(version.session_id).to.match(/^[0-9a-f]{24}$/);
    });

    it('starts the version counter above existing legacy numbers', async () => {
      DriveFileVersionRepository.getLatestVersion.resolves({ version_number: 9, saved_by: null, uploaded_by: UPLOADER, created_on: 4000 });
      await DriveVersionStore.recordEditorSave({
        file: liveFile(), projectId: PROJECT, userId: SAVER, buffer: Buffer.from('q'),
      });
      expect(DriveFileRepository.raiseVersionSeqFloor.firstCall.args[0]).to.deep.equal({ fileId: FILE_ID, floor: 9 });
    });

    it('labels a legacy file\'s baseline with the newest legacy saver', async () => {
      DriveFileVersionRepository.getLatestVersion.resolves({ version_number: 3, saved_by: null, uploaded_by: SAVER, created_on: 4000 });
      await DriveVersionStore.recordEditorSave({
        file: liveFile(), projectId: PROJECT, userId: SAVER, buffer: Buffer.from('q'),
      });
      expect(created[0]).to.include({ save_type: 'legacy', saved_by: SAVER, saved_at: 4000 });
    });

    it('compares every type the editor opens, skipping other types and large files', async () => {
      const { comparisonFor } = DriveVersionStore;
      ['xlsx', 'xls', 'ods', 'csv', 'docx', 'doc', 'odt', 'rtf', 'txt', 'pptx', 'ppt', 'odp'].forEach((extension) => {
        expect(comparisonFor({ file: { file_name: `a.${extension}` }, sizeBytes: 10, hasPrevious: true }))
          .to.deep.equal({ status: 'pending', reason: '' });
      });
      expect(comparisonFor({ file: { file_name: 'a.pdf' }, sizeBytes: 10, hasPrevious: true }))
        .to.deep.equal({ status: 'skipped', reason: 'unsupported_type' });
      expect(comparisonFor({ file: { file_name: 'a.xlsx' }, sizeBytes: 50 * 1024 * 1024, hasPrevious: true }))
        .to.deep.equal({ status: 'skipped', reason: 'too_large' });
      expect(comparisonFor({ file: { file_name: 'a.xlsx' }, sizeBytes: 10, hasPrevious: false }))
        .to.deep.equal({ status: 'none', reason: '' });
    });

    it('puts versions skipped before their type could be compared back in the queue, once', async () => {
      const update = sandbox.stub(DriveFileVersionRepository, 'updateVersions').resolves();
      const skipped = (id, extra = {}) => ({
        _id: id, file_size_bytes: 10, changes: { status: 'skipped', reason: 'unsupported_type' }, ...extra,
      });
      const ids = await DriveVersionStore.requeueNewlyComparable({
        file: { file_name: 'Notes.doc' },
        versions: [
          skipped('a'),
          skipped('b', { changes: { status: 'done' } }),
          skipped('c', { file_size_bytes: 50 * 1024 * 1024 }),
          skipped('d', { changes: { status: 'skipped', reason: 'too_large' } }),
        ],
      });
      expect(ids).to.deep.equal(['a']);
      const { filters, data } = update.firstCall.args[0];
      expect(filters).to.deep.include({ 'changes.status': 'skipped', 'changes.reason': 'unsupported_type' });
      expect(data).to.include({ 'changes.status': 'pending', 'changes.attempts': 0 });

      update.resetHistory();
      expect(await DriveVersionStore.requeueNewlyComparable({ file: { file_name: 'Scan.pdf' }, versions: [skipped('e')] }))
        .to.deep.equal([]);
      expect(update.called).to.equal(false);
    });

    it('propagates an S3 failure and records no version', async () => {
      s3Send.rejects(new Error('AccessDenied'));
      let error;
      try {
        await DriveVersionStore.recordEditorSave({
          file: liveFile({ current_version_id: 'ver-0' }), projectId: PROJECT, userId: SAVER, buffer: Buffer.from('a'),
        });
      } catch (e) { error = e; }
      expect(error?.message).to.equal('AccessDenied');
      expect(DriveFileVersionRepository.createVersion.called).to.equal(false);
    });
  });

  describe('restoreFromVersion', () => {
    const old = {
      _id: 'ver-2', version_number: 2, s3_key: `${PROJECT}/drive/versions/${FILE_ID}/2-1.xlsx`, s3_bucket: 'bucket-a', file_size_bytes: 77, content_sha256: 'abc',
    };

    it('records the restore as a new version by the restorer', async () => {
      const { version } = await DriveVersionStore.restoreFromVersion({
        file: liveFile(), projectId: PROJECT, userId: SAVER, version: old,
      });
      expect(version).to.include({
        save_type: 'restore', saved_by: SAVER, restored_from: 'ver-2', file_size_bytes: 77, content_sha256: 'abc',
      });
      // Baseline of the pre-restore content, then the restore
      expect(created.map((v) => v.save_type)).to.deep.equal(['upload', 'restore']);
    });

    it('fails when the S3 copy fails instead of reporting success', async () => {
      DriveFileVersionRepository.getVersion.resolves({ _id: 'ver-9', saved_at: 1, save_type: 'autosave' });
      // First copy (version -> new key) works, second (-> live key) fails
      s3Send.onSecondCall().rejects(new Error('NoSuchKey'));
      let error;
      try {
        await DriveVersionStore.restoreFromVersion({
          file: liveFile({ current_version_id: 'ver-9' }), projectId: PROJECT, userId: SAVER, version: old,
        });
      } catch (e) { error = e; }
      expect(error?.message).to.equal('NoSuchKey');
      expect(DriveFileRepository.updateFile.called).to.equal(false);
    });
  });
});
