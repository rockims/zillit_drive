/**
 * "Let others know you updated this file": the person who edited tells
 * everyone with access, once, with an optional note. A save alone never
 * notifies anyone.
 */
const { expect } = require('chai');
const sinon = require('sinon');

const DriveEditAnnouncement = require('../src/services/v2/driveEditAnnouncement').default;
const {
  NOTE_MAX_LENGTH, cleanNote, messageFor, resetForTests,
} = require('../src/services/v2/driveEditAnnouncement');
const DriveFileRepository = require('../src/repositories/v2/driveFile').default;
const DriveFolderRepository = require('../src/repositories/v2/driveFolder').default;
const DriveFileAccessService = require('../src/services/v2/driveFileAccess').default;
const DriveNotificationReceivers = require('../src/services/v2/driveNotificationReceivers').default;

const PROJECT = '64b000000000000000000001';
const AVIRAL = '64b000000000000000000aaa';
const ANKIT = '64b000000000000000000bbb';
const RIYA = '64b000000000000000000ccc';
const OWNER = '64b000000000000000000ddd';
const FOLDER_OWNER = '64b000000000000000000eee';
const FILE = '64b0000000000000000000f1';
const FOLDER = '64b0000000000000000000d1';

const failure = async (run) => {
  try { await run(); } catch (error) { return error; }
  return null;
};

describe('notify collaborators about an edit', () => {
  let permissions;
  let file;
  let clock;

  const announce = (extra = {}) => DriveEditAnnouncement.announce({
    user: { _id: AVIRAL, full_name: 'Aviral Pal' },
    project: { _id: PROJECT },
    params: { fileId: FILE },
    body: { note: 'Updated the budget for Day 3' },
    ...extra,
  });
  const sent = () => DriveNotificationReceivers.notifyAllTabRouted.firstCall.args[0];

  beforeEach(() => {
    resetForTests();
    clock = sinon.useFakeTimers({ now: 1790000000000, toFake: ['Date'] });
    permissions = { can_view: true, can_edit: true };
    file = {
      _id: FILE, file_name: 'Budget.xlsx', folder_id: FOLDER, created_by: OWNER, uploaded_by: OWNER,
    };
    // The file that was asked for, so two file ids are two files.
    sinon.stub(DriveFileRepository, 'getFile').callsFake(async ({ filters }) => (file ? { ...file, _id: filters._id } : null));
    sinon.stub(DriveFolderRepository, 'getFolder').resolves({ _id: FOLDER, created_by: FOLDER_OWNER });
    sinon.stub(DriveFileAccessService, 'resolveFilePermission').callsFake(async () => permissions);
    sinon.stub(DriveNotificationReceivers, 'getFileReceivers').resolves([ANKIT, RIYA]);
    sinon.stub(DriveNotificationReceivers, 'notifyAllTabRouted').resolves();
  });

  afterEach(() => {
    clock.restore();
    sinon.restore();
  });

  it('tells everyone with access, the owners included, and never the sender', async () => {
    const result = await announce();
    expect(result).to.deep.equal({ notified: 4 });
    expect(sent().receiverIds).to.have.members([ANKIT, RIYA, OWNER, FOLDER_OWNER]);
    expect(sent().receiverIds).to.not.include(AVIRAL);
    expect(DriveNotificationReceivers.getFileReceivers.firstCall.args[0]).to.include({ actorId: AVIRAL, fileId: FILE, folderId: FOLDER });
  });

  it('does not notify the sender when they are the owner', async () => {
    file = { ...file, created_by: AVIRAL, uploaded_by: AVIRAL };
    await announce();
    expect(sent().receiverIds).to.have.members([ANKIT, RIYA, FOLDER_OWNER]);
  });

  it('says who updated which file, with their note', async () => {
    await announce();
    expect(sent().message).to.equal('Aviral Pal updated "Budget.xlsx": Updated the budget for Day 3');
    expect(sent().referenceData).to.include({ file_id: FILE, file_name: 'Budget.xlsx', note: 'Updated the budget for Day 3', announced_by_editor: true });
  });

  it('is the notification the apps already show for an updated file', async () => {
    await announce();
    expect(sent()).to.include({ action: 'drive_file_updated', unit: 'drive_file_label', itemId: FILE, folderId: FOLDER });
    expect(sent().parentFolderOwnerId).to.equal(FOLDER_OWNER);
  });

  it('works without a note', async () => {
    await announce({ body: {} });
    expect(sent().message).to.equal('Aviral Pal updated "Budget.xlsx"');
    expect(sent().referenceData.note).to.equal('');
  });

  it('keeps a note to one clean line of limited length', () => {
    expect(cleanNote('  Updated\n\tthe   budget\u0000  ')).to.equal('Updated the budget');
    expect(cleanNote('x'.repeat(NOTE_MAX_LENGTH + 50))).to.have.length(NOTE_MAX_LENGTH);
    expect(cleanNote(undefined)).to.equal('');
    expect(messageFor({ userName: 'A', fileName: 'f.md', note: '' })).to.equal('A updated "f.md"');
  });

  it('THE RULE: only someone who can edit the file can announce an edit', async () => {
    permissions = { can_view: true, can_edit: false };
    expect((await failure(() => announce())).message).to.equal('no_edit_permission');
    permissions = null;
    expect((await failure(() => announce())).message).to.equal('insufficient_permissions');
    expect(DriveNotificationReceivers.notifyAllTabRouted.called).to.equal(false);
  });

  it('refuses a second announcement for the same file within a minute, then allows it', async () => {
    await announce();
    expect((await failure(() => announce())).message).to.equal('drive_edit_announce_too_soon');
    expect(DriveNotificationReceivers.notifyAllTabRouted.callCount).to.equal(1);

    clock.tick(61 * 1000);
    await announce();
    expect(DriveNotificationReceivers.notifyAllTabRouted.callCount).to.equal(2);
  });

  it('lets a different person, or the same person on another file, announce straight away', async () => {
    await announce();
    await announce({ user: { _id: ANKIT, full_name: 'Ankit Singh' } });
    await announce({ params: { fileId: '64b0000000000000000000f2' } });
    expect(DriveNotificationReceivers.notifyAllTabRouted.callCount).to.equal(3);
  });

  it('does not use up the minute when sending failed', async () => {
    DriveNotificationReceivers.notifyAllTabRouted.onFirstCall().rejects(new Error('socket down'));
    expect((await failure(() => announce())).message).to.equal('socket down');
    await announce();
    expect(DriveNotificationReceivers.notifyAllTabRouted.callCount).to.equal(2);
  });

  it('says so when nobody else has access', async () => {
    file = { ...file, folder_id: null, created_by: AVIRAL, uploaded_by: AVIRAL };
    DriveNotificationReceivers.getFileReceivers.resolves([]);
    expect(await announce()).to.deep.equal({ notified: 0 });
    expect(DriveNotificationReceivers.notifyAllTabRouted.called).to.equal(false);
  });

  it('reports a missing file', async () => {
    file = null;
    expect((await failure(() => announce())).message).to.equal('file_not_found');
  });

  it('is served under the editor routes', () => {
    const routes = require('../src/routes/v2/driveEditor').default.stack
      .filter((layer) => layer.route)
      .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
    expect(routes).to.include('POST /:fileId/announce');
  });
});
