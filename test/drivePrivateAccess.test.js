/**
 * Private Drive — Access Isolation & Security Tests
 *
 * Validates that Drive is fully private:
 *  - Admin users have NO special bypass
 *  - Users can only see their own items or explicitly shared items
 *  - Folder role resolution respects explicit access only
 *  - No data leaks between users
 */
const { expect } = require('chai');
const sinon = require('sinon');

const DriveAccessService = require('../src/services/v2/driveAccess').default;
const DriveFolderRepository = require('../src/repositories/v2/driveFolder').default;
const DriveFolderAccessRepository = require('../src/repositories/v2/driveFolderAccess').default;
const DriveFileAccessRepository = require('../src/repositories/v2/driveFileAccess').default;

describe('Private Drive — Access Isolation', () => {
  let sandbox;

  const project = { _id: 'project-1' };

  // Two regular users and one admin
  const userA = { _id: 'user-a', admin_access: false };
  const userB = { _id: 'user-b', admin_access: false };
  const adminUser = { _id: 'admin-1', admin_access: true };

  // Folder created by userA
  const folderByA = {
    _id: 'folder-a1',
    project_id: 'project-1',
    created_by: 'user-a',
    parent_folder_id: null,
    folder_name: 'User A Private',
  };

  // Folder created by userB
  const folderByB = {
    _id: 'folder-b1',
    project_id: 'project-1',
    created_by: 'user-b',
    parent_folder_id: null,
    folder_name: 'User B Private',
  };

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  /* ─── Admin Has No Bypass ─── */

  describe('admin has no special bypass', () => {
    it('resolveFolderRole returns null for admin with no explicit access', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'countAccesses').resolves(1);
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);
      sandbox.stub(DriveFolderRepository, 'getFolder').resolves(null);

      const role = await DriveAccessService.resolveFolderRole({
        user: adminUser,
        project,
        folder: folderByA,
      });

      // Admin should NOT get 'owner' by default — no access record means no role
      expect(role).to.equal(null);
    });

    it('listAccessibleFolderIds returns filtered list for admin (not null)', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'distinctFolderIds').resolves([]);
      sandbox.stub(DriveFolderRepository, 'getFolders')
        .onCall(0).resolves([])  // own folders
        .onCall(1).resolves([]); // descendants
      sandbox.stub(DriveFileAccessRepository, 'distinctFileIds').resolves([]);

      const result = await DriveAccessService.listAccessibleFolderIds({
        user: adminUser,
        project,
      });

      // Should NOT be null (null means "no filter" = see everything)
      expect(result).to.not.equal(null);
      expect(result).to.be.an('array');
    });

    it('admin cannot access folder created by another user without explicit sharing', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'countAccesses').resolves(1);
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);
      sandbox.stub(DriveFolderRepository, 'getFolder').resolves(null);

      try {
        await DriveAccessService.assertFolderAccess({
          user: adminUser,
          project,
          folder: folderByA,
          minRole: 'viewer',
        });
        throw new Error('Expected assertFolderAccess to throw');
      } catch (error) {
        expect(error.message).to.equal('insufficient_permissions');
      }
    });
  });

  /* ─── Cross-User Isolation ─── */

  describe('cross-user data isolation', () => {
    it('userB cannot access folder created by userA without sharing', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'countAccesses').resolves(1);
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);
      sandbox.stub(DriveFolderRepository, 'getFolder').resolves(null);

      try {
        await DriveAccessService.assertFolderAccess({
          user: userB,
          project,
          folder: folderByA,
          minRole: 'viewer',
        });
        throw new Error('Expected assertFolderAccess to throw');
      } catch (error) {
        expect(error.message).to.equal('insufficient_permissions');
      }
    });

    it('userA cannot access folder created by userB without sharing', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'countAccesses').resolves(1);
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);
      sandbox.stub(DriveFolderRepository, 'getFolder').resolves(null);

      try {
        await DriveAccessService.assertFolderAccess({
          user: userA,
          project,
          folder: folderByB,
          minRole: 'viewer',
        });
        throw new Error('Expected assertFolderAccess to throw');
      } catch (error) {
        expect(error.message).to.equal('insufficient_permissions');
      }
    });

    it('listAccessibleFolderIds only returns folders user owns or has access to', async () => {
      // userA has direct access to folder-a1, owns folder-a2
      sandbox.stub(DriveFolderAccessRepository, 'distinctFolderIds').resolves(['folder-a1']);
      sandbox.stub(DriveFolderRepository, 'getFolders')
        .onCall(0).resolves([{ _id: 'folder-a2' }]) // owned folders
        .onCall(1).resolves([]);                      // descendants
      sandbox.stub(DriveFileAccessRepository, 'distinctFileIds').resolves([]);

      const result = await DriveAccessService.listAccessibleFolderIds({
        user: userA,
        project,
      });

      expect(result).to.be.an('array');
      expect(result).to.include('folder-a1');
      expect(result).to.include('folder-a2');
      // Should NOT include folder-b1 (userB's folder)
      expect(result).to.not.include('folder-b1');
    });
  });

  /* ─── Explicit Sharing Works ─── */

  describe('explicit sharing grants access', () => {
    it('userB can access folder after being shared with viewer role', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'countAccesses').resolves(2);
      // Direct access lookup returns viewer role for userB
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves({ role: 'viewer' });

      const role = await DriveAccessService.resolveFolderRole({
        user: userB,
        project,
        folder: folderByA,
      });

      expect(role).to.equal('viewer');
    });

    it('userB can access folder after being shared with editor role', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'countAccesses').resolves(2);
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves({ role: 'editor' });

      const role = await DriveAccessService.resolveFolderRole({
        user: userB,
        project,
        folder: folderByA,
      });

      expect(role).to.equal('editor');
    });

    it('folder creator always gets owner role', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'countAccesses').resolves(1);
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);

      const role = await DriveAccessService.resolveFolderRole({
        user: userA,
        project,
        folder: folderByA,
      });

      expect(role).to.equal('owner');
    });

    it('assertFolderAccess passes for shared user with sufficient role', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'countAccesses').resolves(2);
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves({ role: 'editor' });

      // Should not throw
      await DriveAccessService.assertFolderAccess({
        user: userB,
        project,
        folder: folderByA,
        minRole: 'viewer',
      });
    });

    it('assertFolderAccess throws for shared user with insufficient role', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'countAccesses').resolves(2);
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves({ role: 'viewer' });

      try {
        await DriveAccessService.assertFolderAccess({
          user: userB,
          project,
          folder: folderByA,
          minRole: 'editor',
        });
        throw new Error('Expected assertFolderAccess to throw');
      } catch (error) {
        expect(error.message).to.equal('insufficient_permissions');
      }
    });
  });

  /* ─── setFolderAccessList Security ─── */

  describe('setFolderAccessList security', () => {
    it('always forces actor to have owner role even if lower role is passed', async () => {
      // Stub resolveFolderRole's dependencies — actor is creator so gets 'owner'
      sandbox.stub(DriveFolderAccessRepository, 'countAccesses').resolves(1);
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);
      const upsertStub = sandbox.stub(DriveFolderAccessRepository, 'upsertAccess').resolves({});
      sandbox.stub(DriveFolderAccessRepository, 'getAccesses').resolves([]);

      await DriveAccessService.setFolderAccessList({
        user: userA,
        project,
        folder: folderByA, // created_by: 'user-a' → resolves as owner
        entries: [
          { user_id: 'user-a', role: 'viewer' }, // Trying to downgrade self
          { user_id: 'user-b', role: 'editor' },
        ],
        replaceExisting: false,
      });

      const actorPayload = upsertStub
        .getCalls()
        .map((call) => call.args[0].data)
        .find((data) => data.user_id === 'user-a');

      expect(actorPayload.role).to.equal('owner');
    });

    it('soft-deletes access for users removed from list when replaceExisting=true', async () => {
      // Stub resolveFolderRole's dependencies — actor is creator so gets 'owner'
      sandbox.stub(DriveFolderAccessRepository, 'countAccesses').resolves(1);
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);
      const updateStub = sandbox.stub(DriveFolderAccessRepository, 'updateAccesses').resolves({});
      sandbox.stub(DriveFolderAccessRepository, 'upsertAccess').resolves({});
      sandbox.stub(DriveFolderAccessRepository, 'getAccesses').resolves([]);

      await DriveAccessService.setFolderAccessList({
        user: userA,
        project,
        folder: folderByA,
        entries: [
          { user_id: 'user-b', role: 'viewer' },
        ],
        replaceExisting: true,
      });

      expect(updateStub.calledOnce).to.equal(true);
      const keepUsers = updateStub.firstCall.args[0].filters.user_id.$nin;
      expect(keepUsers).to.include('user-a');
      expect(keepUsers).to.include('user-b');
    });
  });
});
