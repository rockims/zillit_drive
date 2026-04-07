import DriveFolderAccessRepository from '../../repositories/v2/driveFolderAccess.js';
import DriveFileAccessRepository from '../../repositories/v2/driveFileAccess.js';

const toIdString = (value) => (value ? value.toString() : null);

/**
 * Get ACL-aware receiver list for a FOLDER operation.
 * Returns user IDs who have access records on the given folder, excluding the actor.
 *
 * @param {Object} params
 * @param {Object} params.project - project object with _id
 * @param {string} params.actorId - user._id of the person performing the action (excluded from receivers)
 * @param {string} params.folderId - the folder being operated on
 * @returns {Promise<string[]>} - array of user ID strings
 */
const getFolderReceivers = async ({ project, actorId, folderId }) => {
  if (!folderId) return [];

  const accessRecords = await DriveFolderAccessRepository.getAccesses({
    filters: {
      project_id: project._id,
      folder_id: folderId,
      deleted_on: 0,
    },
    sort: { created_on: 1 },
  });

  return accessRecords
    .map((r) => toIdString(r.user_id))
    .filter((id) => id && id !== toIdString(actorId));
};

/**
 * Get ACL-aware receiver list for a FILE operation.
 * Merges file-level access users + parent folder access users, excluding the actor.
 *
 * @param {Object} params
 * @param {Object} params.project - project object with _id
 * @param {string} params.actorId - user._id of the person performing the action
 * @param {string} params.fileId - the file being operated on
 * @param {string|null} params.folderId - parent folder ID of the file (null for root-level files)
 * @returns {Promise<string[]>} - array of unique user ID strings
 */
const getFileReceivers = async ({ project, actorId, fileId, folderId }) => {
  const actorIdStr = toIdString(actorId);

  // 1. Get explicit file-level access users
  const fileAccessRecords = await DriveFileAccessRepository.getAccesses({
    filters: {
      project_id: project._id,
      file_id: fileId,
      deleted_on: 0,
    },
  });

  const fileUserIds = fileAccessRecords
    .map((r) => toIdString(r.user_id))
    .filter((id) => id && id !== actorIdStr);

  // 2. Get folder-level access users (if file is inside a folder)
  let folderUserIds = [];
  if (folderId) {
    const folderAccessRecords = await DriveFolderAccessRepository.getAccesses({
      filters: {
        project_id: project._id,
        folder_id: folderId,
        deleted_on: 0,
      },
      sort: { created_on: 1 },
    });

    folderUserIds = folderAccessRecords
      .map((r) => toIdString(r.user_id))
      .filter((id) => id && id !== actorIdStr);
  }

  // 3. Merge and deduplicate
  return [...new Set([...fileUserIds, ...folderUserIds])];
};

/**
 * Get ACL-aware receiver list for a MOVE operation (file or folder).
 * Merges users from both source and destination locations, excluding the actor.
 *
 * @param {Object} params
 * @param {Object} params.project - project object with _id
 * @param {string} params.actorId - user._id of the person performing the action
 * @param {string|null} params.sourceFolderId - the folder the item is being moved FROM
 * @param {string|null} params.targetFolderId - the folder the item is being moved TO
 * @returns {Promise<string[]>} - array of unique user ID strings
 */
const getMoveReceivers = async ({ project, actorId, sourceFolderId, targetFolderId }) => {
  const [sourceUsers, targetUsers] = await Promise.all([
    sourceFolderId ? getFolderReceivers({ project, actorId, folderId: sourceFolderId }) : [],
    targetFolderId ? getFolderReceivers({ project, actorId, folderId: targetFolderId }) : [],
  ]);

  return [...new Set([...sourceUsers, ...targetUsers])];
};

export default {
  getFolderReceivers,
  getFileReceivers,
  getMoveReceivers,
};
