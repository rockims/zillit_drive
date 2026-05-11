import mongoose from 'mongoose';
import DriveFolder from 'zillit-libs/mongo-models-v2/DriveFolder';
import NotificationService from 'zillit-libs/services-v2/notification';
import DriveFolderAccessRepository from '../../repositories/v2/driveFolderAccess.js';
import DriveFileAccessRepository from '../../repositories/v2/driveFileAccess.js';

const toIdString = (value) => (value ? value.toString() : null);

/**
 * Resolves the folder ancestry chain and builds dynamic notification levels.
 * Walks from the given folder up to root using $graphLookup, then maps:
 *   - level_1 = root ancestor (topmost parent)
 *   - level_2 = second-level folder
 *   - level_3 = third-level folder
 *   - levels = ["level_4:id", "level_5:id", ...] for depth > 3
 *     (Labeled strings `level_N:id` — self-describing for the client, and still a
 *      plain-string element so it fits NotificationsV2.levels schema type `[String]`.
 *      Pushing raw objects like `{ level_4: id }` throws a CastError in mongoose,
 *      which kills the notification save path and silently drops the
 *      `notification:save` socket event for any depth > 3 drive event. Label:value
 *      strings avoid the CastError and give frontends explicit depth info without
 *      requiring a shared-libs schema change.)
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
      // Push a labeled string `level_N:id`. Fits NotificationsV2 schema `[String]` and
      // lets the client parse depth without relying on array-index arithmetic:
      //   const [label, id] = entry.split(':');   // e.g. 'level_4' + 'abc…'
      result.levels.push(`level_${index + 1}:${fId}`);
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
    .map((r) => toIdString(r.user_id?._id || r.user_id))
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
    .map((r) => toIdString(r.user_id?._id || r.user_id))
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
      .map((r) => toIdString(r.user_id?._id || r.user_id))
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

/* ───────────── View Classification (My Drive vs Shared with Me) ───────────── */

// Unit constants per FE-requested split — see README. Each drive notification
// now carries one of these two units based on whether the root ancestor of
// the item is owned by the receiver (My Drive) or by someone else (Shared
// with Me). This eliminates client-side classification logic and the race
// conditions it caused (folder list not loaded → badge dropped on wrong tab).
const DRIVE_UNIT_MY_DRIVE = 'drive_my_drive_label';
const DRIVE_UNIT_SHARED_WITH_ME = 'drive_shared_with_me_label';

/**
 * Resolve the owner (created_by) of the root ancestor for a drive item.
 *
 * - If level_1 is a folder id, look up that folder's created_by.
 * - If level_1 is the 'root' sentinel (item at project root with no parent
 *   folder), the item itself IS the root — look up its created_by.
 *
 * Returns the owner user id as a string, or null if the lookup fails.
 *
 * Used by classifyReceiversByView to bucket receivers into the
 * `drive_my_drive_label` vs `drive_shared_with_me_label` units.
 */
const resolveRootAncestorOwner = async ({ project, level_1: level1, referenceId, isFile }) => {
  // Lazy import to avoid circular dependency with driveFile/driveFolder repos.
  const DriveFolderRepository = (await import('../../repositories/v2/driveFolder.js')).default;
  const DriveFileRepository = (await import('../../repositories/v2/driveFile.js')).default;

  if (!level1 || level1 === 'root') {
    // Item is at project root — the item itself is the "ancestor".
    if (!referenceId) return null;
    const repo = isFile ? DriveFileRepository : DriveFolderRepository;
    const fetcher = isFile ? repo.getFile : repo.getFolder;
    const item = await fetcher({
      filters: { _id: referenceId, project_id: project._id },
    });
    return toIdString(item?.created_by) || null;
  }

  const folder = await DriveFolderRepository.getFolder({
    filters: { _id: level1, project_id: project._id },
  });
  return toIdString(folder?.created_by) || null;
};

/**
 * Bucket receivers by view: receivers who own the root ancestor go to
 * "My Drive", everyone else goes to "Shared with Me". Each bucket is meant
 * to be sent in a separate notifyAll call with the appropriate unit.
 *
 * @param {Object} params
 * @param {string|null} params.rootOwnerId — receiver id (as string) who owns the
 *   root ancestor folder/file. If null, all receivers fall into shared.
 * @param {Array<string|ObjectId>} params.receivers — list of receiver ids
 * @returns {{ myDrive: string[], shared: string[] }} normalized id-string arrays
 */
const classifyReceiversByView = ({ rootOwnerId, receivers }) => {
  const ownerStr = toIdString(rootOwnerId);
  const myDrive = [];
  const shared = [];
  for (const r of receivers || []) {
    const rStr = toIdString(r?._id || r);
    if (!rStr) continue;
    if (ownerStr && rStr === ownerStr) {
      myDrive.push(rStr);
    } else {
      shared.push(rStr);
    }
  }
  return { myDrive, shared };
};

/**
 * Wrapper around NotificationService.notifyAll that splits the receivers list
 * by view (My Drive vs Shared with Me) and dispatches two notifyAll calls —
 * one with `unit: drive_my_drive_label` for receivers who own the root
 * ancestor, one with `unit: drive_shared_with_me_label` for everyone else.
 *
 * The caller passes a single base payload (with whatever `action`,
 * `reference_id`, `level_*`, `reference_data`, `message` it normally would)
 * and the helper:
 *   1. Resolves the root ancestor's owner.
 *   2. Classifies receivers by view.
 *   3. Calls notifyAll up to twice — once per non-empty bucket, each time
 *      overriding `unit` to the matching `DRIVE_UNIT_*` constant.
 *
 * The base payload's `unit` is overridden — callers can omit it.
 *
 * @param {Object} params
 * @param {Object} params.payload — base notification payload (without unit/receiver)
 * @param {Array} params.receivers — receivers to be split and notified
 * @param {Object} params.settings — notify options (notify/save/silent/etc)
 * @param {Function} params.socketClient — socket client to use
 * @param {Object} params.project — project doc (passed to resolveRootAncestorOwner)
 * @param {string|null} params.level_1 — the level_1 from buildNotificationLevels
 * @param {string} params.reference_id — the item id (file or folder being acted on)
 * @param {boolean} params.isFile — true if this is a file event, false for folder
 */
const notifyAllByView = async ({
  payload, receivers, settings, socketClient,
  project, level_1: level1, reference_id: referenceId, isFile,
}) => {
  if (!receivers || receivers.length === 0) return;

  const rootOwnerId = await resolveRootAncestorOwner({
    project, level_1: level1, referenceId, isFile,
  });
  const { myDrive, shared } = classifyReceiversByView({
    rootOwnerId,
    receivers,
  });

  const tasks = [];
  if (myDrive.length > 0) {
    tasks.push(NotificationService.notifyAll(
      { ...payload, unit: DRIVE_UNIT_MY_DRIVE, receiver: myDrive },
      settings,
      socketClient,
    ));
  }
  if (shared.length > 0) {
    tasks.push(NotificationService.notifyAll(
      { ...payload, unit: DRIVE_UNIT_SHARED_WITH_ME, receiver: shared },
      settings,
      socketClient,
    ));
  }
  await Promise.all(tasks);
};

export default {
  buildNotificationLevels,
  getFolderReceivers,
  getFileReceivers,
  getMoveReceivers,
  resolveRootAncestorOwner,
  classifyReceiversByView,
  notifyAllByView,
  DRIVE_UNIT_MY_DRIVE,
  DRIVE_UNIT_SHARED_WITH_ME,
};
