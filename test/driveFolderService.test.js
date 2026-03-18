const { expect } = require('chai');
const sinon = require('sinon');

const DriveFolderService = require('../src/services/v2/driveFolder').default;
const DriveFolderRepository = require('../src/repositories/v2/driveFolder').default;
const DriveFileRepository = require('../src/repositories/v2/driveFile').default;
const DriveAccessService = require('../src/services/v2/driveAccess').default;

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
    it('returns paginated and grouped contents sorted by backend query', async () => {
      sandbox.stub(DriveAccessService, 'listAccessibleFolderIds').resolves(null);
      sandbox.stub(DriveFolderRepository, 'getFolders').resolves([
        {
          _id: 'folder-b',
          folder_name: 'Zeta',
          created_by: 'user-1',
          created_on: 1000,
          updated_on: 1001,
          parent_folder_id: null,
        },
        {
          _id: 'folder-a',
          folder_name: 'Alpha',
          created_by: 'user-1',
          created_on: 1000,
          updated_on: 1002,
          parent_folder_id: null,
        },
      ]);
      sandbox.stub(DriveFileRepository, 'getFiles').resolves([
        {
          _id: 'file-b',
          file_name: 'b.txt',
          created_by: 'user-1',
          created_on: 1000,
          updated_on: 1004,
          file_size_bytes: 20,
          file_extension: 'txt',
          folder_id: null,
        },
        {
          _id: 'file-a',
          file_name: 'a.txt',
          created_by: 'user-1',
          created_on: 1000,
          updated_on: 1005,
          file_size_bytes: 10,
          file_extension: 'txt',
          folder_id: null,
        },
      ]);

      const response = await DriveFolderService.getDriveContents({
        user: { _id: 'admin-1', admin_access: true },
        project,
        query: {
          root: 'true',
          sort_by: 'name',
          sort_order: 'asc',
          group_by: 'type',
          paginate: 'true',
          limit: '3',
          offset: '0',
        },
      });

      expect(response.pagination.total).to.equal(4);
      expect(response.items).to.have.length(3);
      expect(response.items.map((item) => item.name)).to.deep.equal([
        'a.txt',
        'Alpha',
        'b.txt',
      ]);
      expect(response.grouping).to.deep.equal([
        { key: 'Files', count: 2 },
        { key: 'Folders', count: 1 },
      ]);
      expect(response.counts).to.deep.equal({
        folders: 2,
        files: 2,
        total: 4,
      });
    });

    it('supports quick_filter=large_files using file size threshold', async () => {
      const getFoldersStub = sandbox
        .stub(DriveFolderRepository, 'getFolders')
        .resolves([]);
      sandbox.stub(DriveAccessService, 'listAccessibleFolderIds').resolves(null);
      sandbox.stub(DriveFileRepository, 'getFiles').resolves([
        {
          _id: 'file-big',
          file_name: 'render.mov',
          created_by: 'user-2',
          created_on: 1000,
          updated_on: 1001,
          file_size_bytes: 2048,
          file_extension: 'mov',
          folder_id: null,
        },
      ]);

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

      expect(getFoldersStub.called).to.equal(false);
      expect(response.counts).to.deep.equal({
        folders: 0,
        files: 1,
        total: 1,
      });
      expect(response.items[0].type).to.equal('file');
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
      sandbox.stub(DriveAccessService, 'listAccessibleFolderIds').resolves(null);
      sandbox.stub(DriveFolderRepository, 'getFolders').resolves([]);
      sandbox.stub(DriveFileRepository, 'getFiles').resolves([]);

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
