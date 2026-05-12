import mongoose from 'mongoose';
import DriveFolder from 'zillit-libs/mongo-models-v2/DriveFolder';
import NotificationService from 'zillit-libs/services-v2/notification';
import DriveFolderAccessRepository from '../../repositories/v2/driveFolderAccess.js';
import DriveFileAccessRepository from '../../repositories/v2/driveFileAccess.js';

const { sections, units } = NotificationService.NotificationConstants;
const DRIVE_TOOL = 'drive_label';

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

/**
 * ZL-18798: wrap buildNotificationLevels so the FE flat-badge schema can
 * route the bell row to the right tab.
 *
 * FE (libs PR #2457) routes by level_1 = sub-unit name. Drive previously
 * used level_1 for the root ancestor folder_id (subtree rollup), which
 * didn't match any known sub-unit → badges fell through both My Drive and
 * Shared with Me tabs.
 *
 * This helper shifts every ancestor level down by one and stamps the
 * tab sub-unit into level_1:
 *
 *   level_1 = tabSubUnit ('my_drive_unit' | 'shared_with_me_unit')
 *   level_2 = was level_1 (root ancestor folder_id)
 *   level_3 = was level_2 (second-level folder_id)
 *   levels  = ['level_4:was_level_3', 'level_5:was_level_4 entry', ...]
 *
 * Subtree rollup still works inside each tab — the FE just keys off
 * level_2/level_3/levels[] instead of level_1.
 *
 * @param {Object} params
 * @param {Object} params.project — project ({_id})
 * @param {string} params.folderId — parent folder of the item (or null for root)
 * @param {string} params.itemId — file_id or folder_id being acted on
 * @param {string} params.tabSubUnit — units.DRIVE_MY or units.DRIVE_SHARED_WITH_ME
 */
const buildTabRoutedLevels = async ({
  project, folderId, itemId, tabSubUnit,
}) => {
  const base = await buildNotificationLevels({ project, folderId, itemId });

  const shifted = {
    reference_id: base.reference_id,
    level_1: tabSubUnit,
    level_2: base.level_1 && base.level_1 !== 'root' ? base.level_1 : null,
    level_3: base.level_2,
    levels: [],
  };

  if (base.level_3) {
    shifted.levels.push(`level_4:${base.level_3}`);
  }

  base.levels.forEach((lvlStr) => {
    const colonAt = lvlStr.indexOf(':');
    if (colonAt < 0) return;
    const label = lvlStr.slice(0, colonAt);
    const id = lvlStr.slice(colonAt + 1);
    const n = parseInt(label.replace('level_', ''), 10);
    if (!Number.isFinite(n)) return;
    shifted.levels.push(`level_${n + 1}:${id}`);
  });

  return shifted;
};

/**
 * ZL-18798: split a list of receiver user_ids into [owners, sharees]
 * based on who owns the relevant item.
 *
 * Owners go to the "My Drive" tab; sharees go to "Shared with Me".
 *
 * @param {Array<string>} receiverIds — full receiver list (already excludes actor)
 * @param {string|null} ownerId — the owning user_id (folder.created_by for nested
 *   items, the folder.created_by for folder events themselves, or null for root
 *   files where every receiver is a sharee).
 * @returns {{ owners: string[], sharees: string[] }}
 */
const splitReceiversByOwnership = (receiverIds = [], ownerId = null) => {
  if (!ownerId) {
    return { owners: [], sharees: [...receiverIds] };
  }
  const ownerStr = toIdString(ownerId);
  const owners = [];
  const sharees = [];
  receiverIds.forEach((rid) => {
    if (toIdString(rid) === ownerStr) owners.push(rid);
    else sharees.push(rid);
  });
  return { owners, sharees };
};

/**
 * ZL-18798: dispatch a drive notification to receivers, splitting them
 * into "My Drive" and "Shared with Me" tabs by ownership and firing the
 * appropriate sub-unit per group.
 *
 * Each call site is one logical event ("file uploaded", "folder updated", etc.)
 * but on the wire it can dispatch up to TWO NotificationService.notifyAll
 * calls — one per tab — because owners (folder.created_by === receiver)
 * see the badge in their My Drive tab, sharees see it in Shared with Me.
 *
 * For SHARE events (drive_*_shared) every receiver is a new sharee by
 * definition. Caller can simply pass parentFolderOwnerId=null so all
 * receivers land in Shared with Me — no split needed.
 *
 * @param {Object} args
 * @param {Object} args.project
 * @param {Object} args.actor — user performing the action ({_id})
 * @param {Array<string|ObjectId>} args.receiverIds — already excludes actor
 * @param {string|null} args.parentFolderOwnerId — folder.created_by; null
 *   for root-level files or share events (all receivers → sharees).
 * @param {string|null} args.folderId — parent folder_id (or null for root)
 * @param {string} args.itemId — file_id or folder_id being acted on
 * @param {string} args.unit — units.DRIVE_FILE or units.DRIVE_FOLDER (well,
 *   currently drive_file_label / drive_folder_label — kept as the
 *   tile-level unit; level_1 is the tab discriminator).
 * @param {string} args.action — e.g. 'drive_file_uploaded'
 * @param {string} args.message
 * @param {Object} args.referenceData
 * @param {Function} args.socketClient
 * @returns {Promise<void>}
 */
const notifyAllTabRouted = async ({
  project, actor, receiverIds, parentFolderOwnerId,
  folderId, itemId, unit, action, message, referenceData,
  socketClient, options = { notify: true, save: true },
}) => {
  if (!Array.isArray(receiverIds) || receiverIds.length === 0) return;

  const { owners, sharees } = splitReceiversByOwnership(receiverIds, parentFolderOwnerId);

  const fire = async (receivers, tabSubUnit) => {
    if (receivers.length === 0) return null;
    const levels = await buildTabRoutedLevels({
      project, folderId, itemId, tabSubUnit,
    });
    const payload = {
      project,
      sender: actor._id,
      receiver: receivers,
      section: sections.TOOLS,
      tool: DRIVE_TOOL,
      unit,
      action,
      reference_id: levels.reference_id,
      level_1: levels.level_1,
      level_2: levels.level_2,
      level_3: levels.level_3,
      levels: levels.levels,
      reference_data: referenceData,
    };
    // Silent-mark notifications use { save: false, silent: true } and omit
    // the visible message; real notify calls use { notify: true, save: true }
    // with a message. Only add the message when it's a real notify.
    if (message) payload.message = message;
    return NotificationService.notifyAll(payload, options, socketClient);
  };

  await Promise.all([
    fire(owners, units.DRIVE_MY),
    fire(sharees, units.DRIVE_SHARED_WITH_ME),
  ]);
};

export default {
  buildNotificationLevels,
  buildTabRoutedLevels,
  splitReceiversByOwnership,
  notifyAllTabRouted,
  getFolderReceivers,
  getFileReceivers,
  getMoveReceivers,
};
