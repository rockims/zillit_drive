import mongoose from 'mongoose';
import DriveFolder from 'zillit-libs/mongo-models-v2/DriveFolder';
import DriveFolderAccessRepository from '../../repositories/v2/driveFolderAccess.js';
import DriveFileAccessRepository from '../../repositories/v2/driveFileAccess.js';

const toIdString = (value) => (value ? value.toString() : null);

/**
 * Resolves the folder ancestry chain and builds dynamic notification levels.
 * Walks from the given folder up to root using $graphLookup, then maps:
 *   - level_1 = root ancestor (topmost parent)
 *   - level_2 = second-level folder
 *   - level_3 = third-level folder
 *   - levels = [{ level_4: "id" }, { level_5: "id" }, ...] for depth > 3
 *   - reference_id = the actual item ID (file or folder being acted on)
 *
 * @param {Object} params
 * @param {Object} params.project - project object with _id
 * @param {string} params.folderId - the folder the item lives in (or the folder itself)
 * @param {string} params.itemId - the actual item ID (file_id or folder_id) for reference_id
 * @returns {Object} { level_1, level_2, level_3, levels, reference_id }
 */
const buildNotificationLevels = async ({ project, folderId, itemId }) => {
  const result = {
    level_1: null,
    level_2: null,
    level_3: null,
    levels: [],
    reference_id: toIdString(itemId),
  };

  if (!folderId) {
    // Root-level item — no folder hierarchy
    result.level_1 = 'root';
    return result;
  }

  // Use $graphLookup to get ALL ancestors in one query (same pattern as driveAccess.js)
  const collectionName = DriveFolder.collection.name;
  const [current] = await DriveFolder.aggregate([
    {
      $match: {
        _id: typeof folderId === 'string' ? new mongoose.Types.ObjectId(folderId) : folderId,
        project_id: project._id,
        deleted_on: 0,
      },
    },
    {
      $graphLookup: {
        from: collectionName,
        startWith: '$parent_folder_id',
        connectFromField: 'parent_folder_id',
        connectToField: '_id',
        as: 'ancestors',
        maxDepth: 50,
        restrictSearchWithMatch: {
          deleted_on: 0,
          project_id: project._id,
        },
      },
    },
    {
      $project: {
        _id: 1,
        parent_folder_id: 1,
        ancestors: { _id: 1, parent_folder_id: 1 },
      },
    },
  ]);

  if (!current) {
    result.level_1 = toIdString(folderId);
    return result;
  }

  // Build ordered chain: root → ... → parent → current folder
  const ancestorMap = new Map();
  (current.ancestors || []).forEach((a) => ancestorMap.set(toIdString(a._id), a));

  // Walk from current folder up to root
  const pathFromCurrentToRoot = [{ _id: current._id, parent_folder_id: current.parent_folder_id }];
  let nextParentId = toIdString(current.parent_folder_id);
  const visited = new Set([toIdString(current._id)]);

  while (nextParentId && !visited.has(nextParentId)) {
    visited.add(nextParentId);
    const ancestor = ancestorMap.get(nextParentId);
    if (!ancestor) break;
    pathFromCurrentToRoot.push(ancestor);
    nextParentId = toIdString(ancestor.parent_folder_id);
  }

  // Reverse to get root → ... → current order
  const orderedPath = pathFromCurrentToRoot.reverse();

  // Map to levels: orderedPath[0] = root (level_1), [1] = level_2, [2] = level_3, [3+] = levels array
  orderedPath.forEach((folder, index) => {
    const fId = toIdString(folder._id);
    if (index === 0) {
      result.level_1 = fId;
    } else if (index === 1) {
      result.level_2 = fId;
    } else if (index === 2) {
      result.level_3 = fId;
    } else {
      result.levels.push({ [`level_${index + 1}`]: fId });
    }
  });

  // If folder itself is at depth 1 (root-level folder), level_1 = folder_id
  if (!result.level_1) {
    result.level_1 = toIdString(folderId);
  }

  return result;
};

/**
 * Get ACL-aware receiver list for a FOLDER operation.
 * Returns user IDs who have access records on the given folder, excluding the actor.
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
 */
const getFileReceivers = async ({ project, actorId, fileId, folderId }) => {
  const actorIdStr = toIdString(actorId);

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

  return [...new Set([...fileUserIds, ...folderUserIds])];
};

/**
 * Get ACL-aware receiver list for a MOVE operation (file or folder).
 * Merges users from both source and destination locations, excluding the actor.
 */
const getMoveReceivers = async ({ project, actorId, sourceFolderId, targetFolderId }) => {
  const [sourceUsers, targetUsers] = await Promise.all([
    sourceFolderId ? getFolderReceivers({ project, actorId, folderId: sourceFolderId }) : [],
    targetFolderId ? getFolderReceivers({ project, actorId, folderId: targetFolderId }) : [],
  ]);

  return [...new Set([...sourceUsers, ...targetUsers])];
};

export default {
  buildNotificationLevels,
  getFolderReceivers,
  getFileReceivers,
  getMoveReceivers,
};
