import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFileAccessRepository from '../../repositories/v2/driveFileAccess.js';

/**
 * DriveStorageService — compute storage usage statistics.
 *
 * Every user sees only storage for files they own or have access to.
 */

const getStorageUsage = async ({ user, project }) => {
  const DriveFile = (await import('zillit-libs/mongo-models-v2/DriveFile')).default;

  // Get file IDs this user has explicit access to
  const userFileAccessRecords = await DriveFileAccessRepository.getAccesses({
    filters: { project_id: project._id, user_id: user._id },
  });
  const accessibleFileIds = userFileAccessRecords.map((a) => a.file_id);

  const userFileFilter = {
    $or: [
      { created_by: user._id },
      { _id: { $in: accessibleFileIds } },
    ],
  };

  const activeMatch = { project_id: project._id, deleted_on: 0, ...userFileFilter };
  const trashMatch = { project_id: project._id, deleted_on: { $gt: 0 }, ...userFileFilter };

  const [result] = await DriveFile.aggregate([
    { $match: activeMatch },
    {
      $group: {
        _id: null,
        totalBytes: { $sum: '$file_size_bytes' },
        totalFiles: { $sum: 1 },
      },
    },
  ]);

  // Breakdown by file type
  const typeBreakdown = await DriveFile.aggregate([
    { $match: activeMatch },
    {
      $group: {
        _id: '$file_type',
        bytes: { $sum: '$file_size_bytes' },
        count: { $sum: 1 },
      },
    },
    { $sort: { bytes: -1 } },
  ]);

  // Trash size (scoped to user's files for non-admins)
  const [trashResult] = await DriveFile.aggregate([
    { $match: trashMatch },
    {
      $group: {
        _id: null,
        totalBytes: { $sum: '$file_size_bytes' },
        totalFiles: { $sum: 1 },
      },
    },
  ]);

  return {
    used_bytes: result?.totalBytes || 0,
    file_count: result?.totalFiles || 0,
    trash_bytes: trashResult?.totalBytes || 0,
    trash_file_count: trashResult?.totalFiles || 0,
    type_breakdown: typeBreakdown.map((t) => ({
      type: t._id || 'unknown',
      bytes: t.bytes,
      count: t.count,
    })),
  };
};

export default {
  getStorageUsage,
};
