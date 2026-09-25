import DriveFileVersion from 'zillit-libs/mongo-models-v2/DriveFileVersion';

const createVersion = ({ data }) => DriveFileVersion.create(data);

const getVersion = ({ filters }) => DriveFileVersion.findOne(filters);

const getVersions = ({ filters, sort = { version_number: 1 }, limit = null }) => {
  const query = DriveFileVersion.find(filters).sort(sort);
  if (limit) query.limit(limit);
  return query;
};

const getLatestVersion = ({ fileId }) => DriveFileVersion
  .findOne({ file_id: fileId })
  .sort({ version_number: -1 });

// The version just before `versionNumber` for the same file.
const getPreviousVersion = ({ fileId, versionNumber }) => DriveFileVersion
  .findOne({ file_id: fileId, version_number: { $lt: versionNumber } })
  .sort({ version_number: -1 });

const hasLegacyVersions = ({ fileId }) => DriveFileVersion
  .exists({ file_id: fileId, saved_by: null });

const updateVersion = ({ filters, data }) => DriveFileVersion.updateOne(filters, { $set: data });

/**
 * Claim the oldest version waiting for its comparison. A run left in
 * "running" longer than `staleBefore` (a crashed process) is claimed again.
 */
const claimPendingComparison = ({ now, staleBefore, maxAttempts }) => DriveFileVersion.findOneAndUpdate(
  {
    'changes.attempts': { $lt: maxAttempts },
    $or: [
      { 'changes.status': 'pending' },
      { 'changes.status': 'running', 'changes.claimed_at': { $lt: staleBefore } },
    ],
  },
  {
    $set: { 'changes.status': 'running', 'changes.claimed_at': now },
    $inc: { 'changes.attempts': 1 },
  },
  { sort: { saved_at: 1 }, new: true },
);

export default {
  createVersion,
  getVersion,
  getVersions,
  getLatestVersion,
  getPreviousVersion,
  hasLegacyVersions,
  updateVersion,
  claimPendingComparison,
};
