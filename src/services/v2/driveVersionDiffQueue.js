import path from 'path';
import { fork } from 'child_process';

import DriveFileVersionRepository from '../../repositories/v2/driveFileVersion.js';
import DriveFileVersionChangeRepository from '../../repositories/v2/driveFileVersionChange.js';
import socketClient from '../../config/socketClient.js';
import { DEFAULT_MAX_CHANGES } from './driveVersionDiff.js';

/**
 * Background comparisons of each saved version against the one before.
 *
 * The queue is the versions collection itself: a version saved with
 * changes.status "pending" is waiting. Claims are atomic, so several Drive
 * processes can share the work. Each comparison runs in a forked child
 * with its own memory cap and a time limit.
 *
 * Switch: DRIVE_VERSION_DIFF_ENABLED=false stops new comparisons.
 */

const ENABLED = process.env.DRIVE_VERSION_DIFF_ENABLED !== 'false';
const MAX_ATTEMPTS = 3;
const STALE_AFTER_MS = 10 * 60 * 1000;
const TIMEOUT_MS = Number(process.env.DRIVE_VERSION_DIFF_TIMEOUT_MS) || 3 * 60 * 1000;
const CHILD_HEAP_MB = Number(process.env.DRIVE_VERSION_DIFF_HEAP_MB) || 1024;
const SWEEP_EVERY_MS = 60 * 1000;
const CHILD_SCRIPT = path.join(__dirname, 'driveVersionDiffChild.js');

let running = false;
let sweepTimer = null;

// Run one comparison in a child process. Always resolves.
const runInChild = (input) => new Promise((resolve) => {
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    resolve(value);
  };

  // Tests and `babel-node` run from src/, where the child needs Babel too.
  const fromSource = __dirname.includes(`${path.sep}src${path.sep}`);
  let child;
  try {
    child = fork(CHILD_SCRIPT, [], {
      execArgv: [
        ...(fromSource ? ['-r', '@babel/register'] : []),
        `--max-old-space-size=${CHILD_HEAP_MB}`,
      ],
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
  } catch (error) {
    finish({ ok: false, error: `fork_failed: ${error.message}` });
    return;
  }

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish({ ok: false, error: 'timed_out' });
  }, TIMEOUT_MS);

  child.once('message', (message) => {
    clearTimeout(timer);
    finish(message || { ok: false, error: 'empty_reply' });
  });
  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    // Killed for memory shows up here as SIGKILL / code 134 with no reply.
    finish({ ok: false, error: `exited_${signal || code}` });
  });
  child.once('error', (error) => {
    clearTimeout(timer);
    finish({ ok: false, error: error.message });
  });

  child.send(input);
});

const emitChanges = (version, status) => {
  socketClient('__admin_events__', {
    event: 'drive:version:changes',
    room: `${version.project_id}_room`,
    data: {
      project_id: version.project_id,
      file_id: version.file_id,
      version_id: version._id,
      status,
    },
  });
};

// Compare one claimed version with the version before it.
const processVersion = async (version) => {
  const previous = await DriveFileVersionRepository.getPreviousVersion({
    fileId: version.file_id,
    versionNumber: version.version_number,
  });

  if (!previous || !previous.s3_key || !version.s3_key) {
    await DriveFileVersionRepository.updateVersion({
      filters: { _id: version._id },
      data: { 'changes.status': 'none', 'changes.computed_at': Date.now() },
    });
    return;
  }

  // Through the exported object so tests can stand in for the child.
  // eslint-disable-next-line no-use-before-define
  const outcome = await DriveVersionDiffQueue.runInChild({
    before: { bucket: previous.s3_bucket, key: previous.s3_key, region: previous.s3_region },
    after: { bucket: version.s3_bucket, key: version.s3_key, region: version.s3_region },
    maxChanges: DEFAULT_MAX_CHANGES,
  });

  if (!outcome.ok) {
    const exhausted = (version.changes?.attempts || 0) >= MAX_ATTEMPTS;
    console.error(`[drive_version_diff_failed] version=${version._id} attempt=${version.changes?.attempts} error=${outcome.error}`);
    await DriveFileVersionRepository.updateVersion({
      filters: { _id: version._id },
      data: {
        'changes.status': exhausted ? 'failed' : 'pending',
        'changes.reason': String(outcome.error).slice(0, 120),
      },
    });
    if (exhausted) emitChanges(version, 'failed');
    return;
  }

  const { total, truncated, sheets } = outcome.result;
  await DriveFileVersionChangeRepository.saveChanges({
    versionId: version._id,
    data: {
      project_id: version.project_id,
      file_id: version.file_id,
      base_version_id: previous._id,
      total,
      truncated,
      sheets,
      created_on: Date.now(),
    },
  });
  await DriveFileVersionRepository.updateVersion({
    filters: { _id: version._id },
    data: {
      'changes.status': 'done',
      'changes.cells': total,
      'changes.sheets': sheets.length,
      'changes.truncated': truncated,
      'changes.reason': '',
      'changes.computed_at': Date.now(),
    },
  });
  emitChanges(version, 'done');
};

// Work through pending comparisons one at a time in this process.
const drain = async () => {
  if (running || !ENABLED) return;
  running = true;
  try {
    for (;;) {
      const now = Date.now();
      // eslint-disable-next-line no-await-in-loop
      const version = await DriveFileVersionRepository.claimPendingComparison({
        now,
        staleBefore: now - STALE_AFTER_MS,
        maxAttempts: MAX_ATTEMPTS,
      });
      if (!version) break;
      // eslint-disable-next-line no-await-in-loop
      await processVersion(version);
    }
  } catch (error) {
    console.error('[drive_version_diff_queue_error]', error.message);
  } finally {
    running = false;
  }
};

// Called after a save; returns immediately.
const kick = () => {
  if (!ENABLED) return;
  setImmediate(() => { drain(); });
};

// Picks up anything a restart or another process left behind.
const start = () => {
  if (!ENABLED || sweepTimer) return;
  sweepTimer = setInterval(kick, SWEEP_EVERY_MS);
  if (sweepTimer.unref) sweepTimer.unref();
  kick();
};

const DriveVersionDiffQueue = {
  start,
  kick,
  drain,
  processVersion,
  runInChild,
};

export default DriveVersionDiffQueue;
