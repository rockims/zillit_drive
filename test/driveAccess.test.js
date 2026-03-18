const { expect } = require('chai');
const sinon = require('sinon');

const DriveAccessService = require('../src/services/v2/driveAccess').default;
const DriveFolderRepository = require('../src/repositories/v2/driveFolder').default;
const DriveFolderAccessRepository = require('../src/repositories/v2/driveFolderAccess').default;

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
    it('returns owner for admin users', async () => {
      const role = await DriveAccessService.resolveFolderRole({
        user: { _id: 'admin-1', admin_access: true },
        project,
        folder,
      });

      expect(role).to.equal('owner');
    });

    it('returns direct role when access exists', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'countAccesses').resolves(1);
      sandbox
        .stub(DriveFolderAccessRepository, 'getAccess')
        .onFirstCall()
        .resolves({ role: 'editor' });

      const role = await DriveAccessService.resolveFolderRole({
        user: { _id: 'user-1', admin_access: false },
        project,
        folder,
      });

      expect(role).to.equal('editor');
    });

    it('resolves inherited role from parent folders', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'countAccesses').resolves(1);
      sandbox
        .stub(DriveFolderAccessRepository, 'getAccess')
        .onCall(0)
        .resolves(null)
        .onCall(1)
        .resolves({ role: 'viewer' });
      const getFolderStub = sandbox.stub(DriveFolderRepository, 'getFolder').resolves(null);

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
      expect(getFolderStub.called).to.equal(false);
    });

    it('returns owner when user is folder creator', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'countAccesses').resolves(1);
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);

      const role = await DriveAccessService.resolveFolderRole({
        user: { _id: 'creator-1', admin_access: false },
        project,
        folder: { ...folder, created_by: 'creator-1' },
      });

      expect(role).to.equal('owner');
    });

    it('walks the parent chain and resolves role from ancestor access', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'countAccesses').resolves(1);
      sandbox
        .stub(DriveFolderAccessRepository, 'getAccess')
        .onCall(0)
        .resolves(null)
        .onCall(1)
        .resolves(null)
        .onCall(2)
        .resolves({ role: 'editor' });

      const getFolderStub = sandbox
        .stub(DriveFolderRepository, 'getFolder')
        .resolves({
          _id: 'parent-1',
          parent_folder_id: 'grand-parent-1',
          created_by: 'someone-else',
        });

      const role = await DriveAccessService.resolveFolderRole({
        user: { _id: 'user-3', admin_access: false },
        project,
        folder: {
          ...folder,
          parent_folder_id: 'parent-1',
        },
      });

      expect(role).to.equal('editor');
      expect(getFolderStub.calledOnce).to.equal(true);
    });

    it('returns owner when parent folder in chain is created by the user', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'countAccesses').resolves(1);
      sandbox
        .stub(DriveFolderAccessRepository, 'getAccess')
        .onCall(0)
        .resolves(null)
        .onCall(1)
        .resolves(null);

      sandbox.stub(DriveFolderRepository, 'getFolder').resolves({
        _id: 'parent-creator',
        parent_folder_id: null,
        created_by: 'user-creator',
      });

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

    it('seeds folder owner access when access entries are missing', async () => {
      const upsertStub = sandbox.stub(DriveFolderAccessRepository, 'upsertAccess').resolves({});
      sandbox.stub(DriveFolderAccessRepository, 'countAccesses').resolves(0);
      sandbox
        .stub(DriveFolderAccessRepository, 'getAccess')
        .onFirstCall()
        .resolves(null);

      await DriveAccessService.resolveFolderRole({
        user: { _id: 'viewer-1', admin_access: false },
        project,
        folder,
      });

      expect(upsertStub.calledOnce).to.equal(true);
      expect(upsertStub.firstCall.args[0].data.role).to.equal('owner');
      expect(upsertStub.firstCall.args[0].data.user_id).to.equal('owner-1');
    });
  });

  describe('assertFolderAccess', () => {
    it('throws insufficient_permissions when role does not satisfy minimum role', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'countAccesses').resolves(1);
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
  });

  describe('collectDescendantFolderIds', () => {
    it('collects all descendants breadth-first', async () => {
      sandbox
        .stub(DriveFolderRepository, 'getFolders')
        .onCall(0)
        .resolves([{ _id: 'child-1' }, { _id: 'child-2' }])
        .onCall(1)
        .resolves([{ _id: 'grand-child-1' }])
        .onCall(2)
        .resolves([]);

      const result = await DriveAccessService.collectDescendantFolderIds({
        projectId: project._id,
        rootFolderId: 'root-1',
        includeRoot: true,
      });

      expect(result).to.deep.equal([
        'root-1',
        'child-1',
        'child-2',
        'grand-child-1',
      ]);
    });
  });

  describe('listAccessibleFolderIds', () => {
    it('returns null for admins', async () => {
      const result = await DriveAccessService.listAccessibleFolderIds({
        user: { _id: 'admin', admin_access: true },
        project,
      });

      expect(result).to.equal(null);
    });

    it('returns direct, own, and descendant folders', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'distinctFolderIds').resolves(['seed-1']);
      sandbox
        .stub(DriveFolderRepository, 'getFolders')
        .onCall(0)
        .resolves([{ _id: 'own-1' }])
        .onCall(1)
        .resolves([{ _id: 'desc-1' }])
        .onCall(2)
        .resolves([]);

      const result = await DriveAccessService.listAccessibleFolderIds({
        user: { _id: 'user-1', admin_access: false },
        project,
      });

      expect(result.sort()).to.deep.equal(['desc-1', 'own-1', 'seed-1']);
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
      const updateAccessesStub = sandbox.stub(DriveFolderAccessRepository, 'updateAccesses').resolves({});
      const upsertAccessStub = sandbox.stub(DriveFolderAccessRepository, 'upsertAccess').resolves({});
      sandbox.stub(DriveFolderAccessRepository, 'getAccesses').resolves([{ user_id: 'any' }]);

      const result = await DriveAccessService.setFolderAccessList({
        user: { _id: 'actor-10', admin_access: true },
        project,
        folder: { _id: 'folder-10' },
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
      const updateAccessesStub = sandbox.stub(DriveFolderAccessRepository, 'updateAccesses').resolves({});
      sandbox.stub(DriveFolderAccessRepository, 'upsertAccess').resolves({});
      sandbox.stub(DriveFolderAccessRepository, 'getAccesses').resolves([]);

      await DriveAccessService.setFolderAccessList({
        user: { _id: 'actor-11', admin_access: true },
        project,
        folder: { _id: 'folder-11' },
        entries: [
          { user_id: 'user-c', role: 'viewer' },
        ],
        replaceExisting: false,
      });

      expect(updateAccessesStub.called).to.equal(false);
    });

    it('forces actor role to owner even when lower role is passed', async () => {
      const upsertAccessStub = sandbox.stub(DriveFolderAccessRepository, 'upsertAccess').resolves({});
      sandbox.stub(DriveFolderAccessRepository, 'getAccesses').resolves([]);

      await DriveAccessService.setFolderAccessList({
        user: { _id: 'actor-12', admin_access: true },
        project,
        folder: { _id: 'folder-12' },
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
      sandbox
        .stub(DriveFolderAccessRepository, 'getAccesses')
        .onCall(0)
        .resolves([
          { user_id: 'source-1', role: 'viewer' },
          { user_id: 'source-2', role: 'editor' },
        ])
        .onCall(1)
        .resolves([
          { folder_id: 'desc-1', user_id: 'source-1', inherited: false },
        ]);
      sandbox.stub(DriveFolderAccessRepository, 'getAccess').resolves(null);
      const upsertStub = sandbox.stub(DriveFolderAccessRepository, 'upsertAccess').resolves({});
      sandbox
        .stub(DriveFolderRepository, 'getFolders')
        .onCall(0)
        .resolves([{ _id: 'desc-1' }])
        .onCall(1)
        .resolves([]);

      const result = await DriveAccessService.inheritFolderAccessToDescendants({
        user: { _id: 'actor-1', admin_access: true },
        project,
        folder: { _id: 'root-1' },
      });

      expect(result).to.deep.equal({
        updatedFolders: 1,
        inheritedEntries: 1,
      });
      expect(upsertStub.callCount).to.equal(1);
      expect(DriveFolderAccessRepository.getAccess.called).to.equal(false);
    });

    it('returns zero updates when source has no access entries', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'getAccesses').resolves([]);
      const getFoldersStub = sandbox.stub(DriveFolderRepository, 'getFolders').resolves([]);

      const result = await DriveAccessService.inheritFolderAccessToDescendants({
        user: { _id: 'actor-2', admin_access: true },
        project,
        folder: { _id: 'root-empty' },
      });

      expect(result).to.deep.equal({
        updatedFolders: 0,
        inheritedEntries: 0,
      });
      expect(getFoldersStub.called).to.equal(false);
    });

    it('returns zero when there are no descendants for inheritance', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'getAccesses').resolves([
        { user_id: 'source-1', role: 'viewer' },
      ]);
      sandbox.stub(DriveFolderRepository, 'getFolders').resolves([]);

      const result = await DriveAccessService.inheritFolderAccessToDescendants({
        user: { _id: 'actor-3', admin_access: true },
        project,
        folder: { _id: 'leaf-folder' },
      });

      expect(result).to.deep.equal({
        updatedFolders: 0,
        inheritedEntries: 0,
      });
    });
  });

  describe('getFolderAccessList', () => {
    it('returns folder access entries when owner-level access is available', async () => {
      sandbox.stub(DriveFolderAccessRepository, 'countAccesses').resolves(1);
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
