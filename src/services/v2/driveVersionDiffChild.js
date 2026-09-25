/**
 * Child process for one version comparison. Forked by
 * driveVersionDiffQueue.js with its own memory cap, so a large workbook
 * can't stall or exhaust the API process.
 *
 * Receives { before, after, maxChanges } where before/after are
 * { bucket, key, region }; downloads both, compares, replies once, exits.
 */
import { getObjectBuffer } from '../../utils/driveS3.js';
import { diffWorkbookBuffers } from './driveVersionDiff.js';

const reply = (message) => {
  if (process.send) {
    process.send(message, () => process.exit(0));
  } else {
    process.exit(0);
  }
};

process.once('message', async (input) => {
  try {
    const [before, after] = await Promise.all([
      getObjectBuffer(input.before),
      getObjectBuffer(input.after),
    ]);
    const result = diffWorkbookBuffers(before, after, { maxChanges: input.maxChanges });
    reply({ ok: true, result });
  } catch (error) {
    reply({ ok: false, error: error.message || String(error) });
  }
});
