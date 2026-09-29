/**
 * Version comparison queue.
 *
 *  - a finished comparison stores the changes and marks the version done
 *  - a failed one goes back to pending, then fails after the last attempt
 *  - the first version (nothing before it) is marked "none"
 *  - the child process really forks, runs and answers
 */
const { expect } = require('chai');
const sinon = require('sinon');

const DriveVersionDiffQueue = require('../src/services/v2/driveVersionDiffQueue').default;
const DriveFileVersionRepository = require('../src/repositories/v2/driveFileVersion').default;
const DriveFileVersionChangeRepository = require('../src/repositories/v2/driveFileVersionChange').default;
const socketClientModule = require('../src/config/socketClient');

const version = (extra = {}) => ({
  _id: 'v2',
  project_id: 'p1',
  file_id: 'f1',
  version_number: 2,
  s3_key: 'k2.xlsx',
  s3_bucket: 'b',
  s3_region: 'ap-south-1',
  changes: { attempts: 1 },
  ...extra,
});

describe('Drive version comparison queue', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(socketClientModule, 'default');
    sandbox.stub(DriveFileVersionRepository, 'updateVersion').resolves();
    sandbox.stub(DriveFileVersionChangeRepository, 'saveChanges').resolves();
  });

  afterEach(() => sandbox.restore());

  it('stores the changes and marks the version done', async () => {
    sandbox.stub(DriveFileVersionRepository, 'getPreviousVersion').resolves({
      _id: 'v1', s3_key: 'k1.xlsx', s3_bucket: 'b', s3_region: 'ap-south-1',
    });
    sandbox.stub(DriveVersionDiffQueue, 'runInChild').resolves({
      ok: true,
      result: { total: 3, truncated: false, sheets: [{ name: 'S', status: 'changed', total: 3, changes: [] }] },
    });

    await DriveVersionDiffQueue.processVersion(version());

    const input = DriveVersionDiffQueue.runInChild.firstCall.args[0];
    expect(input.before).to.deep.equal({ bucket: 'b', key: 'k1.xlsx', region: 'ap-south-1' });
    expect(input.after).to.deep.equal({ bucket: 'b', key: 'k2.xlsx', region: 'ap-south-1' });
    expect(input.extension).to.equal('xlsx');

    const saved = DriveFileVersionChangeRepository.saveChanges.firstCall.args[0];
    expect(saved.versionId).to.equal('v2');
    expect(saved.data).to.include({ base_version_id: 'v1', total: 3, truncated: false });

    const { data } = DriveFileVersionRepository.updateVersion.lastCall.args[0];
    expect(data).to.include({ 'changes.status': 'done', 'changes.cells': 3, 'changes.sheets': 1 });
    expect(socketClientModule.default.firstCall.args[1].event).to.equal('drive:version:changes');
  });

  it('puts a failed comparison back in the queue', async () => {
    sandbox.stub(DriveFileVersionRepository, 'getPreviousVersion').resolves({ _id: 'v1', s3_key: 'k1', s3_bucket: 'b' });
    sandbox.stub(DriveVersionDiffQueue, 'runInChild').resolves({ ok: false, error: 'timed_out' });

    await DriveVersionDiffQueue.processVersion(version({ changes: { attempts: 1 } }));

    const { data } = DriveFileVersionRepository.updateVersion.lastCall.args[0];
    expect(data).to.deep.equal({ 'changes.status': 'pending', 'changes.reason': 'timed_out' });
    expect(DriveFileVersionChangeRepository.saveChanges.called).to.equal(false);
  });

  it('gives up after the last attempt', async () => {
    sandbox.stub(DriveFileVersionRepository, 'getPreviousVersion').resolves({ _id: 'v1', s3_key: 'k1', s3_bucket: 'b' });
    sandbox.stub(DriveVersionDiffQueue, 'runInChild').resolves({ ok: false, error: 'exited_SIGKILL' });

    await DriveVersionDiffQueue.processVersion(version({ changes: { attempts: 3 } }));

    const { data } = DriveFileVersionRepository.updateVersion.lastCall.args[0];
    expect(data['changes.status']).to.equal('failed');
    expect(socketClientModule.default.firstCall.args[1].data.status).to.equal('failed');
  });

  it('marks the first version as having nothing to compare', async () => {
    sandbox.stub(DriveFileVersionRepository, 'getPreviousVersion').resolves(null);
    sandbox.stub(DriveVersionDiffQueue, 'runInChild');

    await DriveVersionDiffQueue.processVersion(version({ version_number: 1 }));

    expect(DriveVersionDiffQueue.runInChild.called).to.equal(false);
    expect(DriveFileVersionRepository.updateVersion.lastCall.args[0].data['changes.status']).to.equal('none');
  });

  it('forks a real child that answers, even when the download fails', async function forkTest() {
    this.timeout(30000);
    const outcome = await DriveVersionDiffQueue.runInChild({
      before: { bucket: 'zillit-nonexistent-test-bucket-7c1', key: 'a.xlsx', region: 'ap-south-1' },
      after: { bucket: 'zillit-nonexistent-test-bucket-7c1', key: 'b.xlsx', region: 'ap-south-1' },
      maxChanges: 10,
    });
    expect(outcome.ok).to.equal(false);
    expect(outcome.error).to.be.a('string').and.not.match(/^fork_failed|^exited_/);
  });
});
