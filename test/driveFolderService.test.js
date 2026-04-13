const { expect } = require('chai');
const sinon = require('sinon');

const DriveFolderService = require('../src/services/v2/driveFolder').default;
const DriveFolderRepository = require('../src/repositories/v2/driveFolder').default;
const DriveFileRepository = require('../src/repositories/v2/driveFile').default;
const DriveFileAccessRepository = require('../src/repositories/v2/driveFileAccess').default;
const DriveAccessService = require('../src/services/v2/driveAccess').default;
const DriveFolder = require('zillit-libs/mongo-models-v2/DriveFolder').default;
const DriveFile = require('zillit-libs/mongo-models-v2/DriveFile').default;

describe('driveFolder service', () => {
  let sandbox;

  const project = { _id: 'project-1' };

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getDriveContents', () => {
    it('returns paginated contents using aggregation pipeline', async () => {
      // Private Drive: listAccessibleFolderIds returns array (never null)
      sandbox.stub(DriveAccessService, 'listAccessibleFolderIds').resolves(['folder-a', 'folder-b']);
      // Private Drive: file access filter is always applied
      sandbox.stub(DriveFileAccessRepository, 'distinctFileIds').resolves([]);
      // getDriveContents now uses DriveFolder.aggregate for combined results
      sandbox.stub(DriveFolder, 'aggregate').resolves([{
        items: [
          { _id: 'folder-a', type: 'folder', name: 'Alpha', is_folder: true, folder_name: 'Alpha', created_by: 'user-1', created_on: 1000, updated_on: 1002 },
          { _id: 'file-a', type: 'file', name: 'a.txt', file_name: 'a.txt', created_by: 'user-1', created_on: 1000, updated_on: 1005, file_size_bytes: 10 },
        ],
        totalCount: [{ count: 2 }],
        folderCount: [{ count: 1 }],
        fileCount: [{ count: 1 }],
      }]);

      const response = await DriveFolderService.getDriveContents({
        user: { _id: 'user-1', admin_access: false },
        project,
        query: {
          root: 'true',
          sort_by: 'name',
          sort_order: 'asc',
          paginate: 'true',
          limit: '50',
          offset: '0',
        },
      });

      expect(response.items).to.be.an('array');
      expect(response.counts).to.have.property('total');
    });

    it('applies file access filter for non-folder listing', async () => {
      sandbox.stub(DriveAccessService, 'listAccessibleFolderIds').resolves([]);
      const distinctStub = sandbox.stub(DriveFileAccessRepository, 'distinctFileIds').resolves(['file-shared']);
      sandbox.stub(DriveFolder, 'aggregate').resolves([{
        items: [],
        totalCount: [{ count: 0 }],
        folderCount: [{ count: 0 }],
        fileCount: [{ count: 0 }],
      }]);

      await DriveFolderService.getDriveContents({
        user: { _id: 'user-2', admin_access: false },
        project,
        query: {
          root: 'true',
          paginate: 'true',
          limit: '50',
          offset: '0',
        },
      });

      // distinctFileIds should be called to find accessible file IDs
      expect(distinctStub.calledOnce).to.equal(true);
      expect(distinctStub.firstCall.args[0].filters.user_id).to.equal('user-2');
    });

    it('supports quick_filter=large_files using file aggregation', async () => {
      sandbox.stub(DriveAccessService, 'listAccessibleFolderIds').resolves([]);
      sandbox.stub(DriveFileAccessRepository, 'distinctFileIds').resolves([]);
      // large_files filter uses DriveFile.aggregate instead of DriveFolder.aggregate
      sandbox.stub(DriveFile, 'aggregate').resolves([{
        items: [
          { _id: 'file-big', type: 'file', name: 'render.mov', file_name: 'render.mov', file_size_bytes: 2048 },
        ],
        totalCount: [{ count: 1 }],
        folderCount: [{ count: 0 }],
        fileCount: [{ count: 1 }],
      }]);

      const response = await DriveFolderService.getDriveContents({
        user: { _id: 'user-2', admin_access: false },
        project,
        query: {
          quick_filter: 'large_files',
          large_file_threshold_bytes: '1024',
          paginate: 'true',
          limit: '50',
          offset: '0',
        },
      });

      expect(response.counts.files).to.equal(1);
      expect(response.items[0].name).to.equal('render.mov');
    });

    it('checks viewer access when listing a specific folder', async () => {
      const folder = {
        _id: 'folder-10',
        project_id: 'project-1',
        created_by: 'owner-1',
        parent_folder_id: null,
      };
      sandbox.stub(DriveFolderRepository, 'getFolder').resolves(folder);
      sandbox.stub(DriveAccessService, 'assertFolderAccess').resolves(true);
      sandbox.stub(DriveAccessService, 'listAccessibleFolderIds').resolves(['folder-10']);
      sandbox.stub(DriveFolder, 'aggregate').resolves([{
        items: [],
        totalCount: [{ count: 0 }],
        folderCount: [{ count: 0 }],
        fileCount: [{ count: 0 }],
      }]);

      await DriveFolderService.getDriveContents({
        user: { _id: 'member-1', admin_access: false },
        project,
        query: {
          folder_id: 'folder-10',
          paginate: 'true',
          limit: '20',
          offset: '0',
        },
      });

      expect(DriveAccessService.assertFolderAccess.calledOnce).to.equal(true);
      expect(DriveAccessService.assertFolderAccess.firstCall.args[0].minRole).to.equal(
        'viewer',
      );
    });
  });
});
