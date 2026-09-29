/**
 * WOPI endpoints and version history.
 *
 *  - CheckFileInfo sends the content time; a save made against older
 *    content is refused (409 conflict), not silently written
 *  - save type comes from Collabora's headers; "not modified by user"
 *    saves are acknowledged without writing
 *  - version preview tokens are read-only and bound to one version
 *  - legacy records are relabelled with the person who wrote the content
 *  - history groups a session's saves and checks access to the file
 */
const { expect } = require('chai');
const sinon = require('sinon');

const DriveWopiService = require('../src/services/v2/driveWopi').default;
const { WopiConflict, versionFileName } = require('../src/services/v2/driveWopi');
const DriveVersionService = require('../src/services/v2/driveVersion').default;
const { presentVersions, groupSessions, currentEntryFor } = require('../src/services/v2/driveVersion');
const DriveFileRepository = require('../src/repositories/v2/driveFile').default;
const DriveFileVersionRepository = require('../src/repositories/v2/driveFileVersion').default;
const DriveFileAccessService = require('../src/services/v2/driveFileAccess').default;
const DriveVersionStore = require('../src/services/v2/driveVersionStore').default;
const DriveVersionDiffQueue = require('../src/services/v2/driveVersionDiffQueue').default;
const DriveEditPresenceService = require('../src/services/v2/driveEditPresence').default;
const DriveActivityService = require('../src/services/v2/driveActivity').default;
const socketClientModule = require('../src/config/socketClient');

const PROJECT = '64b000000000000000000001';
const USER = '64b000000000000000000aaa';
const OTHER = '64b000000000000000000bbb';
const FILE_ID = '64b0000000000000000000f1';
const VERSION_ID = '64b0000000000000000000a2';

const file = (extra = {}) => ({
  _id: FILE_ID,
  project_id: PROJECT,
  file_name: 'Budget.xlsx',
  file_extension: 'xlsx',
  file_size_bytes: 10,
  created_by: OTHER,
  uploaded_by: OTHER,
  created_on: 1000,
  content_updated_on: 2000,
  current_version_id: null,
  ...extra,
});

const tokenFor = (extra = {}) => DriveWopiService.generateAccessToken({
  user: { _id: USER, full_name: 'Priya' },
  project: { _id: PROJECT },
  file: { _id: FILE_ID },
  canEdit: true,
  canDownload: true,
  ...extra,
}).token;

// Minimal stand-in for an Express request carrying WOPI headers.
const request = (headers = {}, body = Buffer.from('content')) => ({
  body,
  get: (name) => headers[name],
});

describe('Drive WOPI and version history', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(socketClientModule, 'default');
    sandbox.stub(DriveActivityService, 'log').resolves();
    sandbox.stub(DriveVersionDiffQueue, 'kick');
    sandbox.stub(DriveEditPresenceService, 'touch').resolves();
  });

  afterEach(() => sandbox.restore());

  describe('CheckFileInfo', () => {
    it('reports when the content last changed, not the last rename', async () => {
      sandbox.stub(DriveFileRepository, 'getFile').resolves(file({ updated_on: 9999 }));
      const info = await DriveWopiService.checkFileInfo({
        params: { fileId: FILE_ID }, query: { access_token: tokenFor() },
      });
      expect(info.LastModifiedTime).to.equal(new Date(2000).toISOString());
      expect(info.UserCanWrite).to.equal(true);
    });

    it('records that an editor opened the file', async () => {
      sandbox.stub(DriveFileRepository, 'getFile').resolves(file());
      await DriveWopiService.checkFileInfo({ params: { fileId: FILE_ID }, query: { access_token: tokenFor() } });
      expect(DriveEditPresenceService.touch.firstCall.args[0]).to.include({ userId: USER, canEdit: true, state: 'seen' });
    });

    it('opens a version read-only under its own name', async () => {
      sandbox.stub(DriveFileRepository, 'getFile').resolves(file());
      sandbox.stub(DriveFileVersionRepository, 'getVersion').resolves({
        _id: VERSION_ID, version_number: 12, file_size_bytes: 55, saved_at: 3000,
      });
      const { token } = DriveWopiService.generateVersionAccessToken({
        user: { _id: USER }, project: { _id: PROJECT }, file: { _id: FILE_ID }, version: { _id: VERSION_ID }, canDownload: true,
      });
      const info = await DriveWopiService.checkFileInfo({
        params: { fileId: `${FILE_ID}_v${VERSION_ID}` }, query: { access_token: token },
      });
      expect(info).to.include({
        BaseFileName: 'Budget (version 12).xlsx', UserCanWrite: false, ReadOnly: true, Size: 55,
      });
      expect(DriveEditPresenceService.touch.called).to.equal(false);
    });

    it('refuses a live-file token on a version, and a version token on the live file', async () => {
      sandbox.stub(DriveFileRepository, 'getFile').resolves(file());
      const live = tokenFor();
      const { token: versionToken } = DriveWopiService.generateVersionAccessToken({
        user: { _id: USER }, project: { _id: PROJECT }, file: { _id: FILE_ID }, version: { _id: VERSION_ID },
      });
      const attempts = [
        { fileId: `${FILE_ID}_v${VERSION_ID}`, token: live },
        { fileId: FILE_ID, token: versionToken },
      ];
      // eslint-disable-next-line no-restricted-syntax
      for (const { fileId, token } of attempts) {
        let error;
        // eslint-disable-next-line no-await-in-loop
        try { await DriveWopiService.checkFileInfo({ params: { fileId }, query: { access_token: token } }); } catch (e) { error = e; }
        expect(error?.message).to.equal('token_file_mismatch');
      }
    });
  });

  describe('PutFile', () => {
    beforeEach(() => {
      sandbox.stub(DriveFileRepository, 'getFile').resolves(file());
    });

    it('refuses a save made against content that changed since (409 conflict)', async () => {
      sandbox.stub(DriveVersionStore, 'recordEditorSave');
      let error;
      try {
        await DriveWopiService.putFileContents({
          params: { fileId: FILE_ID },
          query: { access_token: tokenFor() },
          req: request({ 'X-COOL-WOPI-Timestamp': new Date(1500).toISOString() }),
        });
      } catch (e) { error = e; }
      expect(error).to.be.instanceOf(WopiConflict);
      expect(DriveVersionStore.recordEditorSave.called).to.equal(false);
    });

    it('saves as an autosave by the token\'s user when the timestamp matches', async () => {
      sandbox.stub(DriveVersionStore, 'recordEditorSave').resolves({
        version: { _id: 'v9', version_number: 9, save_type: 'autosave' }, savedAt: 5000,
      });
      const result = await DriveWopiService.putFileContents({
        params: { fileId: FILE_ID },
        query: { access_token: tokenFor() },
        req: request({ 'X-COOL-WOPI-Timestamp': new Date(2000).toISOString(), 'X-COOL-WOPI-IsAutosave': 'true' }),
      });
      expect(DriveVersionStore.recordEditorSave.firstCall.args[0]).to.include({
        userId: USER, saveType: 'autosave', modifiedByUser: true,
      });
      expect(result.LastModifiedTime).to.equal(new Date(5000).toISOString());
      const events = socketClientModule.default.args.map(([, payload]) => payload.event);
      expect(events).to.include.members(['drive:file:updated', 'drive:version:created']);
      expect(DriveVersionDiffQueue.kick.calledOnce).to.equal(true);
    });

    it('treats an exit save as "exit" and passes "not modified by user" through', async () => {
      sandbox.stub(DriveVersionStore, 'recordEditorSave').resolves({ skipped: 'not_modified_by_user' });
      const result = await DriveWopiService.putFileContents({
        params: { fileId: FILE_ID },
        query: { access_token: tokenFor() },
        req: request({ 'X-COOL-WOPI-IsExitSave': 'true', 'X-COOL-WOPI-IsModifiedByUser': 'false' }),
      });
      expect(DriveVersionStore.recordEditorSave.firstCall.args[0]).to.include({ saveType: 'exit', modifiedByUser: false });
      // Acknowledged with the unchanged content time, no events
      expect(result.LastModifiedTime).to.equal(new Date(2000).toISOString());
      expect(socketClientModule.default.called).to.equal(false);
    });

    it('refuses saves through a version preview token', async () => {
      const { token } = DriveWopiService.generateVersionAccessToken({
        user: { _id: USER }, project: { _id: PROJECT }, file: { _id: FILE_ID }, version: { _id: VERSION_ID },
      });
      let error;
      try {
        await DriveWopiService.putFileContents({
          params: { fileId: `${FILE_ID}_v${VERSION_ID}` }, query: { access_token: token }, req: request(),
        });
      } catch (e) { error = e; }
      expect(error?.message).to.equal('no_edit_permission');
    });
  });

  describe('presenting history', () => {
    it('relabels legacy snapshots with the person who wrote that content', () => {
      // Legacy: each record is the content *before* the save by uploaded_by.
      const records = [
        { _id: 'l1', version_number: 1, uploaded_by: 'alice', created_on: 100 },
        { _id: 'l2', version_number: 2, uploaded_by: 'bob', created_on: 200 },
      ];
      const [first, second] = presentVersions(records, file({ uploaded_by: 'uploader', created_on: 50 }));
      expect(first).to.include({ saved_by: 'uploader', saved_at: 50, legacy: true, save_type: 'legacy' });
      expect(second).to.include({ saved_by: 'alice', saved_at: 100 });
    });

    it('keeps new-style versions as recorded and flags the current one', () => {
      const records = [{
        _id: 'n1', version_number: 3, saved_by: 'carol', saved_at: 300, save_type: 'manual', editors: ['carol', 'dan'], session_id: 's1',
      }];
      const [entry] = presentVersions(records, file({ current_version_id: 'n1' }));
      expect(entry).to.include({
        saved_by: 'carol', saved_at: 300, save_type: 'manual', is_current: true, legacy: false,
      });
      expect(entry.editors).to.deep.equal(['carol', 'dan']);
    });

    it('adds a "current version" entry for a legacy-only history', () => {
      const presented = presentVersions([
        { _id: 'l1', version_number: 1, uploaded_by: 'alice', created_on: 100 },
      ], file());
      const current = currentEntryFor(file(), presented);
      expect(current).to.include({ _id: 'current', is_current: true, saved_by: 'alice', saved_at: 100 });
    });

    it('groups one session\'s saves and merges their editors', () => {
      const groups = groupSessions([
        { _id: 'a', session_id: 's1', saved_at: 300, editors: ['x'] },
        { _id: 'b', session_id: 's1', saved_at: 200, editors: ['y'] },
        { _id: 'c', session_id: 's0', saved_at: 100, editors: ['x'] },
      ]);
      expect(groups).to.have.length(2);
      expect(groups[0]).to.include({ id: 's1', started_at: 200, ended_at: 300 });
      expect(groups[0].editors).to.deep.equal(['x', 'y']);
      expect(groups[0].versions.map((v) => v._id)).to.deep.equal(['a', 'b']);
    });

    it('names a version file "Budget (version 12).xlsx"', () => {
      expect(versionFileName('Budget.xlsx', 12)).to.equal('Budget (version 12).xlsx');
      expect(versionFileName('README', 3)).to.equal('README (version 3)');
    });
  });

  describe('access', () => {
    // assertFileAccess calls its own resolveFilePermission, so stand in for
    // it with the same rule: the permission must be granted.
    const grant = (permissions) => {
      sandbox.stub(DriveFileAccessService, 'resolveFilePermission').resolves(permissions);
      sandbox.stub(DriveFileAccessService, 'assertFileAccess').callsFake(async ({ permission }) => {
        if (!permissions || !permissions[`can_${permission}`]) throw new Error('insufficient_permissions');
      });
    };

    it('refuses the history of a file the user cannot see', async () => {
      sandbox.stub(DriveFileRepository, 'getFile').resolves(file());
      grant(null);
      let error;
      try {
        await DriveVersionService.getHistory({ user: { _id: USER }, project: { _id: PROJECT }, params: { fileId: FILE_ID } });
      } catch (e) { error = e; }
      expect(error?.message).to.equal('insufficient_permissions');
    });

    it('needs edit permission to restore', async () => {
      sandbox.stub(DriveFileRepository, 'getFile').resolves(file());
      grant({ can_view: true, can_edit: false });
      sandbox.stub(DriveVersionStore, 'restoreFromVersion');
      let error;
      try {
        await DriveVersionService.restoreVersion({
          user: { _id: USER }, project: { _id: PROJECT }, params: { fileId: FILE_ID, versionId: VERSION_ID },
        });
      } catch (e) { error = e; }
      expect(error?.message).to.equal('insufficient_permissions');
      expect(DriveVersionStore.restoreFromVersion.called).to.equal(false);
    });

    it('needs download permission for a version download', async () => {
      sandbox.stub(DriveFileRepository, 'getFile').resolves(file());
      grant({ can_view: true, can_download: false });
      let error;
      try {
        await DriveVersionService.getVersionDownloadUrl({
          user: { _id: USER }, project: { _id: PROJECT }, params: { fileId: FILE_ID, versionId: VERSION_ID },
        });
      } catch (e) { error = e; }
      expect(error?.message).to.equal('insufficient_permissions');
    });

    it('returns grouped history with the caller\'s permissions', async () => {
      sandbox.stub(DriveFileRepository, 'getFile').resolves(file({ current_version_id: 'n2' }));
      grant({ can_view: true, can_edit: true, can_download: false });
      sandbox.stub(DriveFileVersionRepository, 'getVersions').resolves([
        { _id: 'n1', version_number: 1, saved_by: OTHER, saved_at: 100, save_type: 'upload', editors: [OTHER], session_id: '' },
        { _id: 'n2', version_number: 2, saved_by: USER, saved_at: 200, save_type: 'autosave', editors: [USER], session_id: 's1' },
      ]);
      const history = await DriveVersionService.getHistory({ user: { _id: USER }, project: { _id: PROJECT }, params: { fileId: FILE_ID } });
      expect(history.permissions).to.deep.equal({ can_edit: true, can_download: false });
      expect(history.sessions.map((g) => g.versions[0]._id)).to.deep.equal(['n2', 'n1']);
      expect(history.sessions[0].versions[0].is_current).to.equal(true);
    });
  });
});
