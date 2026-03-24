/**
 * DriveAccess Service Tests
 *
 * Updated to match the private Drive architecture:
 *  - No admin bypass anywhere
 *  - resolveFolderRole uses $graphLookup (DriveFolder.aggregate)
 *  - listAccessibleFolderIds returns filtered array for all users
 *  - setFolderAccessList calls assertFolderAccess internally (needs role stubs)
 */
const { expect } = require('chai');
const sinon = require('sinon');

const DriveAccessService = require('../src/services/v2/driveAccess').default;
const DriveFolderRepository = require('../src/repositories/v2/driveFolder').default;
const DriveFolderAccessRepository = require('../src/repositories/v2/driveFolderAccess').default;
const DriveFileAccessRepository = require('../src/repositories/v2/driveFileAccess').default;
const DriveFolder = require('zillit-libs/mongo-models-v2/DriveFolder').default;

describe('driveAccess service', () => {
  let sandbox;

  const project = { _id: 'project-1' };
  const folder = {
    _id: 'folder-1',
    project_id: 'project-1',
    created_by: 'owner-1',
    parent_folder_id: null,
  };

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('resolveFolderRole', () => {
    it('returns null for admin with no explicit access (no bypass)', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);

      const role = await DriveAccessService.resolveFolderRole({
        user: { _id: 'admin-1', admin_access: true },
        project,
        folder, // parent_folder_id is null → no ancestor walk
      });

      expect(role).to.equal(null);
    });

    it('returns direct role when access exists', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves({ role: 'editor' });

      const role = await DriveAccessService.resolveFolderRole({
        user: { _id: 'user-1', admin_access: false },
        project,
        folder,
      });

      expect(role).to.equal('editor');
    });

    it('returns owner when user is folder creator', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);

      const role = await DriveAccessService.resolveFolderRole({
        user: { _id: 'creator-1', admin_access: false },
        project,
        folder: { ...folder, created_by: 'creator-1' },
      });

      expect(role).to.equal('owner');
    });

    it('resolves inherited role from ancestor via $graphLookup', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);
      // Stub aggregate for $graphLookup
      sandbox.stub(DriveFolder, 'aggregate').resolves([{
        ancestors: [
          { _id: 'parent-1', parent_folder_id: null, created_by: 'someone-else' },
        ],
      }]);
      // Batch access lookup returns viewer for the ancestor
      sandbox.stub(DriveFolderAccessRepository, 'getAccesses').resolves([
        { folder_id: 'parent-1', role: 'viewer' },
      ]);

      const role = await DriveAccessService.resolveFolderRole({
        user: { _id: 'user-2', admin_access: false },
        project,
        folder: {
          ...folder,
          created_by: 'owner-1',
          parent_folder_id: 'parent-1',
        },
      });

      expect(role).to.equal('viewer');
    });

    it('returns owner when ancestor is created by the user', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);
      sandbox.stub(DriveFolder, 'aggregate').resolves([{
        ancestors: [
          { _id: 'parent-creator', parent_folder_id: null, created_by: 'user-creator' },
        ],
      }]);
      // No access records for ancestor — will check created_by
      sandbox.stub(DriveFolderAccessRepository, 'getAccesses').resolves([]);

      const role = await DriveAccessService.resolveFolderRole({
        user: { _id: 'user-creator', admin_access: false },
        project,
        folder: {
          ...folder,
          created_by: 'other-user',
          parent_folder_id: 'parent-creator',
        },
      });

      expect(role).to.equal('owner');
    });

    it('returns null when no ancestors have access for the user', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);
      sandbox.stub(DriveFolder, 'aggregate').resolves([{
        ancestors: [
          { _id: 'parent-1', parent_folder_id: null, created_by: 'someone-else' },
        ],
      }]);
      sandbox.stub(DriveFolderAccessRepository, 'getAccesses').resolves([]);

      const role = await DriveAccessService.resolveFolderRole({
        user: { _id: 'user-no-access', admin_access: false },
        project,
        folder: {
          ...folder,
          created_by: 'owner-1',
          parent_folder_id: 'parent-1',
        },
      });

      expect(role).to.equal(null);
    });

    it('walks deep ancestor chain and returns closest match', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);
      sandbox.stub(DriveFolder, 'aggregate').resolves([{
        ancestors: [
          { _id: 'parent-1', parent_folder_id: 'grand-parent-1', created_by: 'someone' },
          { _id: 'grand-parent-1', parent_folder_id: null, created_by: 'someone' },
        ],
      }]);
      // Access on parent (closer) as editor, grandparent as viewer
      sandbox.stub(DriveFolderAccessRepository, 'getAccesses').resolves([
        { folder_id: 'parent-1', role: 'editor' },
        { folder_id: 'grand-parent-1', role: 'viewer' },
      ]);

      const role = await DriveAccessService.resolveFolderRole({
        user: { _id: 'user-deep', admin_access: false },
        project,
        folder: {
          ...folder,
          created_by: 'owner-1',
          parent_folder_id: 'parent-1',
        },
      });

      // Closest ancestor (parent-1) wins
      expect(role).to.equal('editor');
    });
  });

  describe('assertFolderAccess', () => {
    it('throws insufficient_permissions when role does not satisfy minimum role', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);

      try {
        await DriveAccessService.assertFolderAccess({
          user: { _id: 'user-no-access', admin_access: false },
          project,
          folder: {
            ...folder,
            created_by: 'owner-2',
            parent_folder_id: null,
          },
          minRole: 'viewer',
        });
        throw new Error('Expected assertFolderAccess to throw');
      } catch (error) {
        expect(error.message).to.equal('insufficient_permissions');
      }
    });

    it('passes when user has sufficient role', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves({ role: 'editor' });

      // Should not throw
      await DriveAccessService.assertFolderAccess({
        user: { _id: 'user-with-access', admin_access: false },
        project,
        folder,
        minRole: 'viewer',
      });
    });
  });

  describe('listAccessibleFolderIds', () => {
    it('returns filtered array for admins (no bypass)', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'distinctFolderIds').resolves([]);
      sandbox.stub(DriveFolderRepository, 'getFolders')
        .onCall(0).resolves([])
        .onCall(1).resolves([]);
      sandbox.stub(DriveFileAccessRepository, 'distinctFileIds').resolves([]);

      const result = await DriveAccessService.listAccessibleFolderIds({
        user: { _id: 'admin', admin_access: true },
        project,
      });

      expect(result).to.not.equal(null);
      expect(result).to.be.an('array');
    });

    it('returns direct and own folders as seed IDs', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'distinctFolderIds').resolves(['seed-1']);
      sandbox.stub(DriveFolderRepository, 'getFolders').resolves([{ _id: 'own-1' }]);
      sandbox.stub(DriveFileAccessRepository, 'distinctFileIds').resolves([]);
      // $graphLookup expansion is skipped with string IDs (non-ObjectId) — tests seed collection
      sandbox.stub(DriveFolder, 'aggregate').resolves([]);

      const result = await DriveAccessService.listAccessibleFolderIds({
        user: { _id: 'user-1', admin_access: false },
        project,
      });

      expect(result.sort()).to.deep.equal(['own-1', 'seed-1']);
    });

    it('includes file access folder IDs in accessible list', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'distinctFolderIds').resolves([]);
      sandbox.stub(DriveFolderRepository, 'getFolders').resolves([]);
      sandbox.stub(DriveFileAccessRepository, 'distinctFileIds').resolves(['file-1']);
      const DriveFileRepository = require('../src/repositories/v2/driveFile').default;
      sandbox.stub(DriveFileRepository, 'getFiles').resolves([
        { _id: 'file-1', folder_id: 'folder-from-file' },
      ]);
      sandbox.stub(DriveFolder, 'aggregate').resolves([]);

      const result = await DriveAccessService.listAccessibleFolderIds({
        user: { _id: 'user-1', admin_access: false },
        project,
      });

      expect(result).to.include('folder-from-file');
    });
  });

  describe('seedFolderAccess', () => {
    it('copies parent access and always grants owner to actor', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'getAccesses').resolves([
        { user_id: 'member-1', role: 'viewer' },
        { user_id: 'member-2', role: 'editor' },
      ]);
      const upsertStub = sandbox.stub(DriveFolderAccessRepository, 'upsertAccess').resolves({});

      await DriveAccessService.seedFolderAccess({
        project,
        user: { _id: 'actor-1' },
        folder: { _id: 'folder-99' },
        parentFolderId: 'parent-99',
      });

      expect(upsertStub.callCount).to.equal(3);
      const finalUpsert = upsertStub.getCall(2).args[0];
      expect(finalUpsert.data.user_id).to.equal('actor-1');
      expect(finalUpsert.data.role).to.equal('owner');
      expect(finalUpsert.data.inherited).to.equal(false);
    });
  });

  describe('setFolderAccessList', () => {
    it('deduplicates roles, enforces actor ownership, and replaces removed users', async () => {
      // Stub resolveFolderRole: actor is folder creator → owner
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);
      const updateAccessesStub = sandbox.stub(DriveFolderAccessRepository, 'updateAccesses').resolves({});
      const upsertAccessStub = sandbox.stub(DriveFolderAccessRepository, 'upsertAccess').resolves({});
      sandbox.stub(DriveFolderAccessRepository, 'getAccesses').resolves([{ user_id: 'any' }]);

      const result = await DriveAccessService.setFolderAccessList({
        user: { _id: 'actor-10' },
        project,
        folder: { _id: 'folder-10', created_by: 'actor-10', parent_folder_id: null },
        entries: [
          { user_id: 'user-a', role: 'viewer' },
          { user_id: 'user-a', role: 'editor' },
          { user_id: 'user-b', role: 'viewer' },
        ],
        replaceExisting: true,
      });

      expect(updateAccessesStub.calledOnce).to.equal(true);
      const keepUsers = updateAccessesStub.firstCall.args[0].filters.user_id.$nin;
      expect(keepUsers.sort()).to.deep.equal(['actor-10', 'user-a', 'user-b']);

      expect(upsertAccessStub.callCount).to.equal(3);
      const upsertPayloads = upsertAccessStub.getCalls().map((call) => call.args[0].data);
      const userA = upsertPayloads.find((payload) => payload.user_id === 'user-a');
      const actor = upsertPayloads.find((payload) => payload.user_id === 'actor-10');

      expect(userA.role).to.equal('editor');
      expect(actor.role).to.equal('owner');
      expect(result).to.deep.equal([{ user_id: 'any' }]);
    });

    it('does not soft-delete users when replaceExisting is false', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);
      const updateAccessesStub = sandbox.stub(DriveFolderAccessRepository, 'updateAccesses').resolves({});
      sandbox.stub(DriveFolderAccessRepository, 'upsertAccess').resolves({});
      sandbox.stub(DriveFolderAccessRepository, 'getAccesses').resolves([]);

      await DriveAccessService.setFolderAccessList({
        user: { _id: 'actor-11' },
        project,
        folder: { _id: 'folder-11', created_by: 'actor-11', parent_folder_id: null },
        entries: [
          { user_id: 'user-c', role: 'viewer' },
        ],
        replaceExisting: false,
      });

      expect(updateAccessesStub.called).to.equal(false);
    });

    it('forces actor role to owner even when lower role is passed', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);
      const upsertAccessStub = sandbox.stub(DriveFolderAccessRepository, 'upsertAccess').resolves({});
      sandbox.stub(DriveFolderAccessRepository, 'getAccesses').resolves([]);

      await DriveAccessService.setFolderAccessList({
        user: { _id: 'actor-12' },
        project,
        folder: { _id: 'folder-12', created_by: 'actor-12', parent_folder_id: null },
        entries: [
          { user_id: 'actor-12', role: 'viewer' },
          { user_id: 'user-d', role: 'viewer' },
        ],
        replaceExisting: false,
      });

      const actorPayload = upsertAccessStub
        .getCalls()
        .map((call) => call.args[0].data)
        .find((data) => data.user_id === 'actor-12');

      expect(actorPayload.role).to.equal('owner');
    });
  });

  describe('inheritFolderAccessToDescendants', () => {
    it('inherits entries while preserving explicit descendant access', async () => {
      const rootId = '69bd44ae7c279cc3e7322aa3';
      const descId = '69bd44ae7c279cc3e7322aa4';
      const actorId = '69bd44ae7c279cc3e7322aa5';
      // Actor is folder creator → passes assertFolderAccess
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);
      sandbox
        .stub(DriveFolderAccessRepository, 'getAccesses')
        .onCall(0)
        .resolves([
          { user_id: 'source-1', role: 'viewer' },
          { user_id: 'source-2', role: 'editor' },
        ])
        .onCall(1)
        .resolves([
          { folder_id: descId, user_id: 'source-1', inherited: false },
        ]);
      const upsertStub = sandbox.stub(DriveFolderAccessRepository, 'upsertAccess').resolves({});
      // Stub collectDescendantFolderIds — uses DriveFolder.aggregate with $graphLookup
      sandbox.stub(DriveFolder, 'aggregate').resolves([{
        descendants: [descId],
      }]);

      const result = await DriveAccessService.inheritFolderAccessToDescendants({
        user: { _id: actorId },
        project,
        folder: { _id: rootId, created_by: actorId, parent_folder_id: null },
      });

      expect(result).to.deep.equal({
        updatedFolders: 1,
        inheritedEntries: 1,
      });
      expect(upsertStub.callCount).to.equal(1);
    });

    it('returns zero updates when source has no access entries', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);
      sandbox.stub(DriveFolderAccessRepository, 'getAccesses').resolves([]);

      const result = await DriveAccessService.inheritFolderAccessToDescendants({
        user: { _id: 'actor-2' },
        project,
        folder: { _id: 'root-empty', created_by: 'actor-2', parent_folder_id: null },
      });

      expect(result).to.deep.equal({
        updatedFolders: 0,
        inheritedEntries: 0,
      });
    });

    it('returns zero when there are no descendants for inheritance', async () => {
      const leafId = '69bd44ae7c279cc3e7322aa6';
      const actorId = '69bd44ae7c279cc3e7322aa7';
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);
      sandbox.stub(DriveFolderAccessRepository, 'getAccesses').resolves([
        { user_id: 'source-1', role: 'viewer' },
      ]);
      // No descendants returned from $graphLookup
      sandbox.stub(DriveFolder, 'aggregate').resolves([{
        descendants: [],
      }]);

      const result = await DriveAccessService.inheritFolderAccessToDescendants({
        user: { _id: actorId },
        project,
        folder: { _id: leafId, created_by: actorId, parent_folder_id: null },
      });

      expect(result).to.deep.equal({
        updatedFolders: 0,
        inheritedEntries: 0,
      });
    });
  });

  describe('getFolderAccessList', () => {
    it('returns folder access entries when owner-level access is available', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves({ role: 'owner' });
      sandbox.stub(DriveFolderAccessRepository, 'getAccesses').resolves([
        { user_id: 'u1', role: 'owner' },
        { user_id: 'u2', role: 'viewer' },
      ]);

      const accessList = await DriveAccessService.getFolderAccessList({
        user: { _id: 'owner-user', admin_access: false },
        project,
        folder,
      });

      expect(accessList).to.deep.equal([
        { user_id: 'u1', role: 'owner' },
        { user_id: 'u2', role: 'viewer' },
      ]);
    });
  });

  describe('softDeleteFolderAccess', () => {
    it('delegates soft delete to repository', async () => {
      const updateAccessesStub = sandbox.stub(DriveFolderAccessRepository, 'updateAccesses').resolves({});

      await DriveAccessService.softDeleteFolderAccess({
        projectId: 'project-soft-delete',
        folderIds: ['f1', 'f2'],
        data: { deleted_on: 12345 },
      });

      expect(updateAccessesStub.calledOnce).to.equal(true);
      expect(updateAccessesStub.firstCall.args[0]).to.deep.equal({
        filters: {
          project_id: 'project-soft-delete',
          folder_id: { $in: ['f1', 'f2'] },
          deleted_on: 0,
        },
        data: { deleted_on: 12345 },
      });
    });
  });
});
