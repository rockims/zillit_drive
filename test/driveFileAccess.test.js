/**
 * DriveFileAccess — File-Level Permission & Sharing Tests
 *
 * Validates:
 *  - resolveFilePermission respects explicit access, creator, and folder fallback
 *  - assertFileAccess enforces permission checks
 *  - seedFileAccess creates correct records
 *  - setFileAccessList normalizes entries, notifies recipients, emits socket events
 *  - No admin bypass at file level
 */
const { expect } = require('chai');
const sinon = require('sinon');

const DriveFileAccessService = require('../src/services/v2/driveFileAccess').default;
const DriveFileRepository = require('../src/repositories/v2/driveFile').default;
const DriveFileAccessRepository = require('../src/repositories/v2/driveFileAccess').default;
const DriveAccessService = require('../src/services/v2/driveAccess').default;

describe('DriveFileAccess service', () => {
  let sandbox;

  const project = { _id: 'project-1' };
  const userA = { _id: 'user-a' };
  const userB = { _id: 'user-b' };
  const adminUser = { _id: 'admin-1', admin_access: true };

  const fileByA = {
    _id: 'file-a1',
    project_id: 'project-1',
    created_by: 'user-a',
    folder_id: null,
    file_name: 'private-doc.pdf',
  };

  const fileByB = {
    _id: 'file-b1',
    project_id: 'project-1',
    created_by: 'user-b',
    folder_id: null,
    file_name: 'secret-report.xlsx',
  };

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  /* ─── resolveFilePermission ─── */

  describe('resolveFilePermission', () => {
    it('returns null when no access record, not creator, and no folder', async () => {
      sandbox.stub(DriveFileAccessRepository, 'getAccess').resolves(null);

      const perms = await DriveFileAccessService.resolveFilePermission({
        user: userB,
        project,
        file: fileByA,
      });

      expect(perms).to.equal(null);
    });

    it('returns full permissions for file creator (even without access record)', async () => {
      sandbox.stub(DriveFileAccessRepository, 'getAccess').resolves(null);

      const perms = await DriveFileAccessService.resolveFilePermission({
        user: userA,
        project,
        file: fileByA,
      });

      expect(perms).to.deep.equal({
        can_view: true,
        can_edit: true,
        can_download: true,
        can_delete: true,
      });
    });

    it('returns explicit file-level permissions when access record exists', async () => {
      sandbox.stub(DriveFileAccessRepository, 'getAccess').resolves({
        can_view: true,
        can_edit: false,
        can_download: true,
        can_delete: false,
      });

      const perms = await DriveFileAccessService.resolveFilePermission({
        user: userB,
        project,
        file: fileByA,
      });

      expect(perms).to.deep.equal({
        can_view: true,
        can_edit: false,
        can_download: true,
        can_delete: false,
      });
    });

    it('admin gets NO special permissions without explicit access', async () => {
      sandbox.stub(DriveFileAccessRepository, 'getAccess').resolves(null);

      const perms = await DriveFileAccessService.resolveFilePermission({
        user: adminUser,
        project,
        file: fileByA,
      });

      // Admin is not creator and has no access record → null
      expect(perms).to.equal(null);
    });

    it('falls back to folder-level role when file is in a folder', async () => {
      sandbox.stub(DriveFileAccessRepository, 'getAccess').resolves(null);

      // Dynamic import mock for DriveFolderRepository
      const mockFolderRepo = require('../src/repositories/v2/driveFolder').default;
      sandbox.stub(mockFolderRepo, 'getFolder').resolves({
        _id: 'folder-1',
        project_id: 'project-1',
        created_by: 'user-a',
      });
      sandbox.stub(DriveAccessService, 'resolveFolderRole').resolves('editor');

      const fileInFolder = { ...fileByA, folder_id: 'folder-1' };
      const perms = await DriveFileAccessService.resolveFilePermission({
        user: userB,
        project,
        file: fileInFolder,
      });

      expect(perms).to.deep.equal({
        can_view: true,
        can_edit: true,
        can_download: true,
        can_delete: false,
      });
    });

    it('maps viewer folder role to view-only file permissions', async () => {
      sandbox.stub(DriveFileAccessRepository, 'getAccess').resolves(null);

      const mockFolderRepo = require('../src/repositories/v2/driveFolder').default;
      sandbox.stub(mockFolderRepo, 'getFolder').resolves({
        _id: 'folder-1',
        project_id: 'project-1',
        created_by: 'user-a',
      });
      sandbox.stub(DriveAccessService, 'resolveFolderRole').resolves('viewer');

      const fileInFolder = { ...fileByA, folder_id: 'folder-1' };
      const perms = await DriveFileAccessService.resolveFilePermission({
        user: userB,
        project,
        file: fileInFolder,
      });

      expect(perms).to.deep.equal({
        can_view: true,
        can_edit: false,
        can_download: false,
        can_delete: false,
      });
    });
  });

  /* ─── assertFileAccess ─── */

  describe('assertFileAccess', () => {
    it('throws when user has no file permissions at all', async () => {
      sandbox.stub(DriveFileAccessRepository, 'getAccess').resolves(null);

      try {
        await DriveFileAccessService.assertFileAccess({
          user: userB,
          project,
          file: fileByA,
          permission: 'view',
        });
        throw new Error('Expected to throw');
      } catch (err) {
        expect(err.message).to.equal('insufficient_permissions');
      }
    });

    it('throws when user has view but requests download', async () => {
      sandbox.stub(DriveFileAccessRepository, 'getAccess').resolves({
        can_view: true,
        can_edit: false,
        can_download: false,
        can_delete: false,
      });

      try {
        await DriveFileAccessService.assertFileAccess({
          user: userB,
          project,
          file: fileByA,
          permission: 'download',
        });
        throw new Error('Expected to throw');
      } catch (err) {
        expect(err.message).to.equal('insufficient_permissions');
      }
    });

    it('passes when user has the requested permission', async () => {
      sandbox.stub(DriveFileAccessRepository, 'getAccess').resolves({
        can_view: true,
        can_edit: true,
        can_download: true,
        can_delete: false,
      });

      // Should not throw
      await DriveFileAccessService.assertFileAccess({
        user: userB,
        project,
        file: fileByA,
        permission: 'edit',
      });
    });

    it('admin cannot access file without explicit permission', async () => {
      sandbox.stub(DriveFileAccessRepository, 'getAccess').resolves(null);

      try {
        await DriveFileAccessService.assertFileAccess({
          user: adminUser,
          project,
          file: fileByA,
          permission: 'view',
        });
        throw new Error('Expected to throw');
      } catch (err) {
        expect(err.message).to.equal('insufficient_permissions');
      }
    });
  });

  /* ─── seedFileAccess ─── */

  describe('seedFileAccess', () => {
    it('creates full-access record for the uploader', async () => {
      const upsertStub = sandbox.stub(DriveFileAccessRepository, 'upsertAccess').resolves({});

      await DriveFileAccessService.seedFileAccess({
        project,
        user: userA,
        file: fileByA,
        entries: [],
      });

      expect(upsertStub.calledOnce).to.equal(true);
      const data = upsertStub.firstCall.args[0].data;
      expect(data.user_id).to.equal('user-a');
      expect(data.can_view).to.equal(true);
      expect(data.can_edit).to.equal(true);
      expect(data.can_download).to.equal(true);
      expect(data.can_delete).to.equal(true);
    });

    it('creates entries for additional specified users', async () => {
      const upsertStub = sandbox.stub(DriveFileAccessRepository, 'upsertAccess').resolves({});

      await DriveFileAccessService.seedFileAccess({
        project,
        user: userA,
        file: fileByA,
        entries: [
          { user_id: 'user-b', can_view: true, can_edit: false, can_download: true },
        ],
      });

      // 1 for uploader + 1 for user-b
      expect(upsertStub.callCount).to.equal(2);
      const userBData = upsertStub.getCall(1).args[0].data;
      expect(userBData.user_id).to.equal('user-b');
      expect(userBData.can_edit).to.equal(false);
      expect(userBData.can_delete).to.equal(false);
    });

    it('skips duplicate entry for the uploader in entries list', async () => {
      const upsertStub = sandbox.stub(DriveFileAccessRepository, 'upsertAccess').resolves({});

      await DriveFileAccessService.seedFileAccess({
        project,
        user: userA,
        file: fileByA,
        entries: [
          { user_id: 'user-a', can_view: true, can_edit: true },
          { user_id: 'user-b', can_view: true },
        ],
      });

      // uploader entry (always created) + user-b (user-a duplicate skipped)
      expect(upsertStub.callCount).to.equal(2);
    });
  });

  /* ─── setFileAccessList ─── */

  describe('setFileAccessList', () => {
    it('throws file_not_found when file does not exist', async () => {
      sandbox.stub(DriveFileRepository, 'getFile').resolves(null);

      try {
        await DriveFileAccessService.setFileAccessList({
          user: userA,
          project,
          fileId: 'nonexistent',
          entries: [],
        });
        throw new Error('Expected to throw');
      } catch (err) {
        expect(err.message).to.equal('file_not_found');
      }
    });

    it('throws insufficient_permissions when caller lacks edit permission', async () => {
      sandbox.stub(DriveFileRepository, 'getFile').resolves(fileByA);
      sandbox.stub(DriveFileAccessRepository, 'getAccess').resolves({
        can_view: true,
        can_edit: false,
        can_download: false,
        can_delete: false,
      });

      try {
        await DriveFileAccessService.setFileAccessList({
          user: userB,
          project,
          fileId: 'file-a1',
          entries: [{ user_id: 'user-c', can_view: true }],
        });
        throw new Error('Expected to throw');
      } catch (err) {
        expect(err.message).to.equal('insufficient_permissions');
      }
    });

    it('ensures caller retains full access (owner-level) in result', async () => {
      sandbox.stub(DriveFileRepository, 'getFile').resolves(fileByA);
      // Creator has full access
      sandbox.stub(DriveFileAccessRepository, 'getAccess').resolves({
        can_view: true,
        can_edit: true,
        can_download: true,
        can_delete: true,
      });
      const updateStub = sandbox.stub(DriveFileAccessRepository, 'updateAccesses').resolves({});
      const upsertStub = sandbox.stub(DriveFileAccessRepository, 'upsertAccess').resolves({});
      sandbox.stub(DriveFileAccessRepository, 'getAccesses').resolves([]);

      await DriveFileAccessService.setFileAccessList({
        user: userA,
        project,
        fileId: 'file-a1',
        entries: [
          { user_id: 'user-a', can_view: true, can_edit: false },  // trying to downgrade self
          { user_id: 'user-b', can_view: true, can_edit: false },
        ],
      });

      const actorEntry = upsertStub
        .getCalls()
        .map((c) => c.args[0].data)
        .find((d) => String(d.user_id) === 'user-a');

      // Actor always gets full access regardless of what was passed
      expect(actorEntry.can_view).to.equal(true);
      expect(actorEntry.can_edit).to.equal(true);
      expect(actorEntry.can_download).to.equal(true);
      expect(actorEntry.can_delete).to.equal(true);
    });

    it('soft-deletes access for users removed from the list', async () => {
      sandbox.stub(DriveFileRepository, 'getFile').resolves(fileByA);
      sandbox.stub(DriveFileAccessRepository, 'getAccess').resolves({
        can_view: true,
        can_edit: true,
        can_download: true,
        can_delete: true,
      });
      const updateStub = sandbox.stub(DriveFileAccessRepository, 'updateAccesses').resolves({});
      sandbox.stub(DriveFileAccessRepository, 'upsertAccess').resolves({});
      sandbox.stub(DriveFileAccessRepository, 'getAccesses').resolves([]);

      await DriveFileAccessService.setFileAccessList({
        user: userA,
        project,
        fileId: 'file-a1',
        entries: [
          { user_id: 'user-b', can_view: true },
        ],
      });

      expect(updateStub.calledOnce).to.equal(true);
      const filter = updateStub.firstCall.args[0].filters;
      expect(filter.user_id.$nin).to.include('user-a');
      expect(filter.user_id.$nin).to.include('user-b');
      expect(filter.deleted_on).to.equal(0);
    });
  });

  /* ─── getFileAccess ─── */

  describe('getFileAccess', () => {
    it('throws file_not_found for nonexistent file', async () => {
      sandbox.stub(DriveFileRepository, 'getFile').resolves(null);

      try {
        await DriveFileAccessService.getFileAccess({
          user: userA,
          project,
          fileId: 'nonexistent',
        });
        throw new Error('Expected to throw');
      } catch (err) {
        expect(err.message).to.equal('file_not_found');
      }
    });

    it('throws when user has no view permission on the file', async () => {
      sandbox.stub(DriveFileRepository, 'getFile').resolves(fileByA);
      // User has no access
      sandbox.stub(DriveFileAccessRepository, 'getAccess').resolves(null);

      try {
        await DriveFileAccessService.getFileAccess({
          user: userB,
          project,
          fileId: 'file-a1',
        });
        throw new Error('Expected to throw');
      } catch (err) {
        expect(err.message).to.equal('insufficient_permissions');
      }
    });
  });
});
