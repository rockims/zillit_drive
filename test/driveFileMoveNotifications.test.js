/**
 * DriveFile.moveFile — Notification Receiver Tests (ZL-21405 / ZL-21406)
 *
 * Validates:
 *  - A user the FILE itself is shared with (no folder access) is notified when
 *    the owner moves that root file into a private folder: silent retire of the
 *    old badge + a fresh drive_file_moved save.
 *  - An unshared root file moved into a private folder notifies nobody.
 *  - Folder members who are also file sharees appear once (deduped) — the
 *    pre-existing folder-member path is unchanged.
 *  - The file's owner is routed to My Drive (via parentFolderOwnerId) when an
 *    editor sharee moves the owner's root file.
 *
 * Receiver helpers (getMoveReceivers / getFileReceivers / getFolderReceivers)
 * run for real — only the access repositories underneath them are stubbed.
 */
const { expect } = require('chai');
const sinon = require('sinon');

const DriveFileService = require('../src/services/v2/driveFile').default;
const DriveFileRepository = require('../src/repositories/v2/driveFile').default;
const DriveFileAccessRepository = require('../src/repositories/v2/driveFileAccess').default;
const DriveFolderRepository = require('../src/repositories/v2/driveFolder').default;
const DriveFolderAccessRepository = require('../src/repositories/v2/driveFolderAccess').default;
const DriveAccessService = require('../src/services/v2/driveAccess').default;
const DriveFileAccessService = require('../src/services/v2/driveFileAccess').default;
const DriveActivityService = require('../src/services/v2/driveActivity').default;
const DriveNameResolver = require('../src/services/v2/driveNameResolver').default;
const DriveNotificationReceivers = require('../src/services/v2/driveNotificationReceivers').default;
const NotificationRepository = require('zillit-libs/repositories-v2/notification').default;
const socketClientModule = require('../src/config/socketClient');

describe('DriveFile.moveFile notifications', () => {
  let sandbox;

  const project = { _id: 'project-1' };
  const device = { _id: 'device-1' };
  const userA = { _id: 'user-a' };
  const userB = { _id: 'user-b' };

  const targetFolderOwnedBy = (ownerId) => ({
    _id: 'folder-t',
    created_by: ownerId,
    parent_folder_id: null,
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  /**
   * Stubs every collaborator moveFile touches so no DB / network is hit.
   * The receiver helpers themselves are NOT stubbed — their repositories are,
   * so the real dedupe / actor-exclusion logic is what gets exercised.
   */
  const stubMove = ({
    file,
    foldersById,
    folderAccessRowsByFolderId,
    fileAccessRows,
    priorNotificationIds = ['uuid-old'],
  }) => {
    const movedFile = { ...file, folder_id: 'folder-t' };

    sandbox.stub(DriveFileRepository, 'getFile').resolves(file);
    sandbox.stub(DriveFileRepository, 'updateFileDocument').resolves(movedFile);
    sandbox.stub(DriveFolderRepository, 'getFolder').callsFake(
      ({ filters }) => Promise.resolve(foldersById[filters._id] || null),
    );

    sandbox.stub(DriveAccessService, 'assertFolderAccess').resolves();
    sandbox.stub(DriveFileAccessService, 'snapshotFolderAccessToFile').resolves();
    sandbox.stub(DriveNameResolver, 'resolveAvailableFileName').resolves(file.file_name);
    sandbox.stub(DriveActivityService, 'log').returns(undefined);

    // Read by the real getFolderReceivers / getFileReceivers helpers
    sandbox.stub(DriveFolderAccessRepository, 'getAccesses').callsFake(
      ({ filters }) => Promise.resolve(folderAccessRowsByFolderId[filters.folder_id] || []),
    );
    sandbox.stub(DriveFileAccessRepository, 'getAccesses').resolves(fileAccessRows);

    const getIdsStub = sandbox.stub(NotificationRepository, 'getNotificationIDs').resolves(priorNotificationIds);
    const updateStub = sandbox.stub(NotificationRepository, 'updateNotification').resolves({});
    const notifyStub = sandbox.stub(DriveNotificationReceivers, 'notifyAllTabRouted').resolves();
    const socketStub = sandbox.stub(socketClientModule, 'default');

    return { movedFile, getIdsStub, updateStub, notifyStub, socketStub };
  };

  const callMove = (actor) => DriveFileService.moveFile({
    user: actor,
    project,
    device,
    params: { fileId: 'file-1' },
    body: { target_folder_id: 'folder-t' },
  });

  const notifyArgs = (notifyStub) => notifyStub.getCalls().map((c) => c.args[0]);

  it('notifies a file-level sharee when the owner moves a root file into a private folder (ZL-21405)', async () => {
    const rootFileByA = {
      _id: 'file-1', file_name: 'a.pdf', folder_id: null, created_by: 'user-a',
    };
    const { updateStub, notifyStub } = stubMove({
      file: rootFileByA,
      foldersById: { 'folder-t': targetFolderOwnedBy('user-a') },
      folderAccessRowsByFolderId: { 'folder-t': [{ user_id: 'user-a', role: 'owner' }] },
      fileAccessRows: [
        { user_id: 'user-a', role: 'owner' },
        { user_id: 'user-b', role: 'viewer' },
      ],
    });

    await callMove(userA);

    expect(notifyStub.callCount).to.equal(2);
    const [silentCall, saveCall] = notifyArgs(notifyStub);

    // 1st call: silent retire of the sharee's pre-move badge
    expect(silentCall.options).to.deep.equal({ save: false, silent: true });
    expect(silentCall.action).to.equal('drive_file_moved');
    expect(silentCall.referenceData.read_notification_ids).to.deep.equal(['uuid-old']);

    // 2nd call: the real drive_file_moved save at the new ancestry
    expect(saveCall.options).to.equal(undefined);
    expect(saveCall.action).to.equal('drive_file_moved');
    expect(saveCall.unit).to.equal('drive_file_label');
    expect(saveCall.itemId).to.equal('file-1');
    expect(saveCall.folderId).to.equal('folder-t');

    // Both calls target the file sharee; only the owner is routed to My Drive.
    // moveFile lists [file owner, target-folder owner] without deduping (both
    // are user-a here) — splitReceiversByOwnership Set()s it downstream, so
    // compare the distinct ids.
    [silentCall, saveCall].forEach((args) => {
      expect(args.receiverIds).to.deep.equal(['user-b']);
      expect([...new Set(args.parentFolderOwnerId)]).to.deep.equal(['user-a']);
      expect(args.parentFolderOwnerId).to.not.include('user-b');
    });

    // Prior unread notifications for the sharee are marked read
    expect(updateStub.callCount).to.equal(1);
    expect(updateStub.firstCall.args[0].filters.receiver.$in).to.deep.equal(['user-b']);
  });

  it('stays silent when an unshared root file is moved into a private folder', async () => {
    const rootFileByA = {
      _id: 'file-1', file_name: 'a.pdf', folder_id: null, created_by: 'user-a',
    };
    const { getIdsStub, notifyStub } = stubMove({
      file: rootFileByA,
      foldersById: { 'folder-t': targetFolderOwnedBy('user-a') },
      folderAccessRowsByFolderId: { 'folder-t': [{ user_id: 'user-a', role: 'owner' }] },
      fileAccessRows: [{ user_id: 'user-a', role: 'owner' }],
    });

    await callMove(userA);

    expect(notifyStub.called).to.equal(false);
    expect(getIdsStub.called).to.equal(false);
  });

  it('keeps folder members once when they are also file sharees', async () => {
    const fileInFolderS = {
      _id: 'file-1', file_name: 'a.pdf', folder_id: 'folder-s', created_by: 'user-a',
    };
    const memberRows = [
      { user_id: 'user-a', role: 'owner' },
      { user_id: 'user-c', role: 'editor' },
    ];
    const { notifyStub } = stubMove({
      file: fileInFolderS,
      foldersById: {
        'folder-s': { _id: 'folder-s', created_by: 'user-a' },
        'folder-t': { _id: 'folder-t', created_by: 'user-a' },
      },
      folderAccessRowsByFolderId: { 'folder-s': memberRows, 'folder-t': memberRows },
      fileAccessRows: [
        { user_id: 'user-a', role: 'owner' },
        { user_id: 'user-c', role: 'editor' },
      ],
    });

    await callMove(userA);

    expect(notifyStub.callCount).to.equal(2);
    notifyArgs(notifyStub).forEach((args) => {
      // user-c comes from source folder, target folder AND file access — once
      expect(args.receiverIds).to.deep.equal(['user-c']);
    });
  });

  it("routes the file owner to My Drive when an editor sharee moves the owner's root file", async () => {
    const rootFileByA = {
      _id: 'file-1', file_name: 'a.pdf', folder_id: null, created_by: 'user-a',
    };
    const { notifyStub } = stubMove({
      file: rootFileByA,
      foldersById: { 'folder-t': targetFolderOwnedBy('user-b') },
      folderAccessRowsByFolderId: { 'folder-t': [{ user_id: 'user-b', role: 'owner' }] },
      fileAccessRows: [
        { user_id: 'user-a', role: 'owner' },
        { user_id: 'user-b', role: 'editor' },
      ],
    });
    // Root write check for a non-creator actor reads the singular access row
    sandbox.stub(DriveFileAccessRepository, 'getAccess').resolves({ can_edit: true });

    await callMove(userB);

    expect(notifyStub.callCount).to.equal(2);
    notifyArgs(notifyStub).forEach((args) => {
      expect(args.receiverIds).to.deep.equal(['user-a']);
      expect(args.parentFolderOwnerId).to.include('user-a');
      expect(args.parentFolderOwnerId).to.include('user-b');
    });
  });
});
