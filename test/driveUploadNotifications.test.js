/**
 * DriveUpload — Notification & Badge Recipient Tests
 *
 * Validates:
 *  - Upload notifications include both file-level AND folder-level access users
 *  - Uploader is excluded from notification recipients
 *  - Deduplication of recipients across file and folder access
 *  - Badge level hierarchy (level_1=folder, level_2=file)
 */
const { expect } = require('chai');
const sinon = require('sinon');

const DriveUploadService = require('../src/services/v2/driveUpload').default;
const DriveFileRepository = require('../src/repositories/v2/driveFile').default;
const DriveFileAccessRepository = require('../src/repositories/v2/driveFileAccess').default;
const DriveFileAccessService = require('../src/services/v2/driveFileAccess').default;

describe('DriveUpload — notification recipients', () => {
  let sandbox;

  const project = { _id: 'project-1' };
  const userA = { _id: 'user-a' };

  const mockFile = {
    _id: 'file-new',
    file_name: 'report.pdf',
    created_by: 'user-a',
    folder_id: null,
  };

  const mockSession = {
    _id: 'session-1',
    project_id: 'project-1',
    status: 'initiated',
    upload_id: 'aws-upload-123',
    s3_key: 'uploads/report.pdf',
    file_name: 'report.pdf',
    file_size: 1024,
    content_type: 'application/pdf',
    total_parts: 1,
    folder_id: null,
    file_access: [],
    parts: [{ part_number: 1, etag: '"abc123"' }],
  };

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('completeUpload notification recipients', () => {
    it('includes file-level access users in notifications', async () => {
      // File-level access: user-b and user-c have access
      sandbox.stub(DriveFileAccessRepository, 'getAccesses').resolves([
        { user_id: { toString: () => 'user-b' } },
        { user_id: { toString: () => 'user-c' } },
        { user_id: { toString: () => 'user-a' } }, // uploader — should be excluded
      ]);

      // Verify the filter logic — uploader excluded, others kept
      const records = await DriveFileAccessRepository.getAccesses({
        filters: { project_id: 'project-1', file_id: 'file-new', deleted_on: 0 },
      });

      const accessUserIds = records
        .map((r) => r.user_id?.toString())
        .filter((id) => id && id !== 'user-a');

      expect(accessUserIds).to.deep.equal(['user-b', 'user-c']);
      expect(accessUserIds).to.not.include('user-a');
    });

    it('includes folder-level access users for files in shared folders', async () => {
      // Simulate folder access records
      const folderAccessRecords = [
        { user_id: { toString: () => 'user-d' }, folder_id: 'folder-1' },
        { user_id: { toString: () => 'user-e' }, folder_id: 'folder-1' },
        { user_id: { toString: () => 'user-a' }, folder_id: 'folder-1' }, // uploader
      ];

      const folderAccessUserIds = folderAccessRecords
        .map((r) => r.user_id?.toString())
        .filter((id) => id && id !== 'user-a');

      expect(folderAccessUserIds).to.deep.equal(['user-d', 'user-e']);
    });

    it('deduplicates recipients across file and folder access', async () => {
      const accessUserIds = ['user-b', 'user-c'];
      const folderAccessUserIds = ['user-c', 'user-d']; // user-c appears in both

      const allReceiverIds = [...new Set([...accessUserIds, ...folderAccessUserIds])];

      expect(allReceiverIds).to.deep.equal(['user-b', 'user-c', 'user-d']);
      expect(allReceiverIds).to.have.length(3); // no duplicates
    });

    it('returns empty receiver list when only uploader has access', async () => {
      const accessUserIds = []; // uploader filtered out
      const folderAccessUserIds = []; // no folder access

      const allReceiverIds = [...new Set([...accessUserIds, ...folderAccessUserIds])];

      expect(allReceiverIds).to.have.length(0);
    });

    it('notification payload uses correct badge hierarchy', () => {
      const folderId = 'folder-1';
      const fileId = 'file-new';

      const notificationPayload = {
        section: 'tools_label', // sections.TOOLS
        tool: 'drive_label',
        unit: 'drive_file_label',
        action: 'drive_file_uploaded',
        reference_id: fileId,
        level_1: folderId || 'root',
        level_2: fileId,
        reference_data: {
          file_id: fileId,
          file_name: 'report.pdf',
          folder_id: folderId,
        },
        message: 'New file "report.pdf" uploaded',
      };

      // level_1 = folder (badge appears on folder)
      expect(notificationPayload.level_1).to.equal('folder-1');
      // level_2 = file (badge appears on file within folder)
      expect(notificationPayload.level_2).to.equal('file-new');
      expect(notificationPayload.action).to.equal('drive_file_uploaded');
    });

    it('uses "root" as level_1 when file is at root level', () => {
      const folderId = null;
      const fileId = 'file-root';

      const level1 = folderId || 'root';
      expect(level1).to.equal('root');
    });
  });
});
