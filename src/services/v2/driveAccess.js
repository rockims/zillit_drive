import mongoose from 'mongoose';
import Forbidden from 'zillit-libs/errors/Forbidden';
import NotificationService from 'zillit-libs/services-v2/notification';
import NotificationRepository from 'zillit-libs/repositories-v2/notification';
import DriveFolder from 'zillit-libs/mongo-models-v2/DriveFolder';

import DriveFolderRepository from '../../repositories/v2/driveFolder.js';
import DriveFolderAccessRepository from '../../repositories/v2/driveFolderAccess.js';
import DriveFileAccessRepository from '../../repositories/v2/driveFileAccess.js';
import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveNotificationReceivers from './driveNotificationReceivers.js';
import {
  hasMinRole,
  pickHigherRole,
} from './driveAccessRoles.js';
import socketClient from '../../config/socketClient.js';

const {
  sections, tools, units,
} = NotificationService.NotificationConstants;

const DRIVE_TOOL = 'drive_label';
const DRIVE_UNIT_FOLDER = 'drive_folder_label';

const toIdString = (value) => (value ? value.toString() : null);

const getFolderOrNull = ({ projectId, folderId }) =>
  DriveFolderRepository.getFolder({
    filters: {
      _id: folderId,
      project_id: projectId,
      deleted_on: 0,
    },
  });

const ensureFolderOwnerAccess = async ({ project, folder }) => {
  if (!folder?.created_by) {
    return;
  }

  const accessCount = await DriveFolderAccessRepository.countAccesses({
    filters: {
      project_id: project._id,
      folder_id: folder._id,
      deleted_on: 0,
    },
  });

  if (accessCount > 0) {
    return;
  }

  const now = Date.now();
  await DriveFolderAccessRepository.upsertAccess({
    filters: {
      project_id: project._id,
      folder_id: folder._id,
      user_id: folder.created_by,
      deleted_on: 0,
    },
    data: {
      project_id: project._id,
      folder_id: folder._id,
      user_id: folder.created_by,
      role: 'owner',
      inherited: false,
      created_by: folder.created_by,
      updated_by: folder.created_by,
      created_on: now,
      updated_on: now,
      deleted_on: 0,
    },
  });
};

/**
 * Resolves a user's effective role on a folder using $graphLookup.
 * Replaces the sequential parent-walk (2N queries) with 2 queries regardless of depth.
 *
 * Resolution order:
 * 1. Admin → 'owner'
 * 2. Direct access record on the folder
 * 3. Folder creator → 'owner'
 * 4. $graphLookup ancestor chain → batch access lookup → closest ancestor with access
 */
const resolveFolderRole = async ({ user, project, folder }) => {
  if (!user || !project || !folder) {
    return null;
  }

  // NOTE: ensureFolderOwnerAccess removed — seedFolderAccess already creates
  // owner records at folder creation time. The defensive check was adding
  // 1-2 extra DB queries per permission resolution.

  const directAccess = await DriveFolderAccessRepository.getAccess({
    filters: {
      project_id: project._id,
      folder_id: folder._id,
      user_id: user._id,
      deleted_on: 0,
    },
  });

  if (directAccess?.role) {
    return directAccess.role;
  }

  if (toIdString(folder.created_by) === toIdString(user._id)) {
    return 'owner';
  }

  if (!folder.parent_folder_id) {
    return null;
  }

  // Use $graphLookup to get ALL ancestors in a single DB round-trip
  const collectionName = DriveFolder.collection.name;
  const [result] = await DriveFolder.aggregate([
    { $match: { _id: folder._id, deleted_on: 0 } },
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
        ancestors: { _id: 1, created_by: 1, parent_folder_id: 1 },
      },
    },
  ]);

  const ancestors = result?.ancestors || [];
  if (ancestors.length === 0) {
    return null;
  }

  // Build ordered ancestor chain (closest parent first) for correct resolution
  const ancestorMap = new Map();
  ancestors.forEach((a) => ancestorMap.set(toIdString(a._id), a));

  const orderedAncestors = [];
  let nextParentId = toIdString(folder.parent_folder_id);
  const visited = new Set([toIdString(folder._id)]);

  while (nextParentId && !visited.has(nextParentId)) {
    visited.add(nextParentId);
    const ancestor = ancestorMap.get(nextParentId);
    if (!ancestor) break;
    orderedAncestors.push(ancestor);
    nextParentId = toIdString(ancestor.parent_folder_id);
  }

  if (orderedAncestors.length === 0) {
    return null;
  }

  // Batch-fetch all access records for the entire ancestor chain (1 query)
  const ancestorIds = orderedAncestors.map((a) => a._id);
  const accessRecords = await DriveFolderAccessRepository.getAccesses({
    filters: {
      project_id: project._id,
      folder_id: { $in: ancestorIds },
      user_id: user._id,
      deleted_on: 0,
    },
    sort: { created_on: 1 },
  });

  const accessByFolderId = new Map();
  accessRecords.forEach((rec) => {
    accessByFolderId.set(toIdString(rec.folder_id), rec.role);
  });

  // Walk ordered chain: return first match (closest ancestor wins)
  for (const ancestor of orderedAncestors) {
    const ancestorId = toIdString(ancestor._id);
    const role = accessByFolderId.get(ancestorId);
    if (role) {
      return role;
    }
    if (toIdString(ancestor.created_by) === toIdString(user._id)) {
      return 'owner';
    }
  }

  return null;
};

const assertFolderAccess = async ({ user, project, folder, minRole = 'viewer' }) => {
  const role = await resolveFolderRole({
    user,
    project,
    folder,
  });

  if (!role || !hasMinRole(role, minRole)) {
    throw new Forbidden('insufficient_permissions');
  }
};

/**
 * Collects all descendant folder IDs using $graphLookup.
 * Replaces the BFS loop with a single aggregation query.
 */
const collectDescendantFolderIds = async ({ projectId, rootFolderId, includeRoot = true }) => {
  const collectionName = DriveFolder.collection.name;
  const rootObjectId = rootFolderId instanceof mongoose.Types.ObjectId
    ? rootFolderId
    : new mongoose.Types.ObjectId(toIdString(rootFolderId));

  const [result] = await DriveFolder.aggregate([
    { $match: { _id: rootObjectId, deleted_on: 0, project_id: projectId } },
    {
      $graphLookup: {
        from: collectionName,
        startWith: '$_id',
        connectFromField: '_id',
        connectToField: 'parent_folder_id',
        as: 'descendants',
        maxDepth: 50,
        restrictSearchWithMatch: {
          deleted_on: 0,
          project_id: projectId,
        },
      },
    },
    { $project: { descendants: '$descendants._id' } },
  ]);

  const descendantIds = (result?.descendants || []).map((id) => toIdString(id));

  if (includeRoot) {
    return [toIdString(rootFolderId), ...descendantIds];
  }
  return descendantIds;
};

/**
 * Lists all folder IDs accessible to a user using $graphLookup.
 * Replaces BFS loop with batch expansion from seed folders (2 queries + 1 aggregation).
 */
const listAccessibleFolderIds = async ({ user, project }) => {
  // Get seed folder IDs: direct access + owned folders + folders containing files
  // the user has explicit file-level access to (3 parallel queries)
  const [directIds, ownFolders, fileAccessIds] = await Promise.all([
    DriveFolderAccessRepository.distinctFolderIds({
      filters: {
        project_id: project._id,
        user_id: user._id,
        deleted_on: 0,
      },
    }),
    DriveFolderRepository.getFolders({
      filters: {
        project_id: project._id,
        created_by: user._id,
        deleted_on: 0,
      },
      sort: { _id: 1 },
    }),
    // Find folder IDs of files the user has explicit file-level access to
    (async () => {
      const accessibleFileIds = await DriveFileAccessRepository.distinctFileIds({
        filters: {
          project_id: project._id,
          user_id: user._id,
          can_view: true,
          deleted_on: 0,
        },
      });
      if (accessibleFileIds.length === 0) return [];
      // Get the folder_id for each accessible file
      const files = await DriveFileRepository.getFiles({
        filters: {
          _id: { $in: accessibleFileIds },
          project_id: project._id,
          folder_id: { $ne: null },
          deleted_on: 0,
        },
      });
      return files.map((f) => toIdString(f.folder_id)).filter(Boolean);
    })(),
  ]);

  const seedIds = new Set([
    ...directIds.map((id) => toIdString(id)),
    ...ownFolders.map((folder) => toIdString(folder._id)),
    ...fileAccessIds,
  ]);

  if (seedIds.size === 0) {
    return [];
  }

  const seedObjectIds = Array.from(seedIds)
    .filter(Boolean)
    .map((id) => {
      try {
        return new mongoose.Types.ObjectId(id);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (seedObjectIds.length === 0) {
    return Array.from(seedIds);
  }

  // Expand descendants from all seed folders using $graphLookup (1 aggregation)
  const collectionName = DriveFolder.collection.name;
  const results = await DriveFolder.aggregate([
    {
      $match: {
        _id: { $in: seedObjectIds },
        project_id: project._id,
        deleted_on: 0,
      },
    },
    {
      $graphLookup: {
        from: collectionName,
        startWith: '$_id',
        connectFromField: '_id',
        connectToField: 'parent_folder_id',
        as: 'descendants',
        maxDepth: 50,
        restrictSearchWithMatch: {
          deleted_on: 0,
          project_id: project._id,
        },
      },
    },
    { $project: { descendants: '$descendants._id' } },
  ]);

  const allIds = new Set(seedIds);
  results.forEach((doc) => {
    (doc.descendants || []).forEach((id) => {
      const idStr = toIdString(id);
      if (idStr) allIds.add(idStr);
    });
  });

  // Also include ancestor folders for all seed folders so users can navigate
  // the full folder path to reach folders containing their accessible files.
  // E.g., if user has file access in FolderB (inside FolderA), include FolderA too.
  const ancestorIds = new Set();
  const allFolders = await DriveFolderRepository.getFolders({
    filters: {
      project_id: project._id,
      deleted_on: 0,
    },
  });

  const folderMap = new Map();
  allFolders.forEach((f) => folderMap.set(toIdString(f._id), toIdString(f.parent_folder_id)));

  // Walk up from each seed folder to root, adding ancestors
  for (const seedId of seedIds) {
    let current = folderMap.get(seedId);
    while (current && !allIds.has(current) && !ancestorIds.has(current)) {
      ancestorIds.add(current);
      current = folderMap.get(current);
    }
  }

  ancestorIds.forEach((id) => allIds.add(id));

  return Array.from(allIds);
};

const seedFolderAccess = async ({ project, user, folder, parentFolderId = null }) => {
  const now = Date.now();

  if (parentFolderId) {
    const parentAccessList = await DriveFolderAccessRepository.getAccesses({
      filters: {
        project_id: project._id,
        folder_id: parentFolderId,
        deleted_on: 0,
      },
      sort: { created_on: 1 },
    });

    await Promise.all(
      parentAccessList.map((accessItem) =>
        DriveFolderAccessRepository.upsertAccess({
          filters: {
            project_id: project._id,
            folder_id: folder._id,
            user_id: accessItem.user_id,
            deleted_on: 0,
          },
          data: {
            project_id: project._id,
            folder_id: folder._id,
            user_id: accessItem.user_id,
            role: accessItem.role,
            inherited: true,
            created_by: user._id,
            updated_by: user._id,
            created_on: now,
            updated_on: now,
            deleted_on: 0,
          },
        })
      )
    );
  }

  await DriveFolderAccessRepository.upsertAccess({
    filters: {
      project_id: project._id,
      folder_id: folder._id,
      user_id: user._id,
      deleted_on: 0,
    },
    data: {
      project_id: project._id,
      folder_id: folder._id,
      user_id: user._id,
      role: 'owner',
      inherited: false,
      created_by: user._id,
      updated_by: user._id,
      created_on: now,
      updated_on: now,
      deleted_on: 0,
    },
  });
};

const getFolderAccessList = async ({ user, project, folder }) => {
  await assertFolderAccess({
    user,
    project,
    folder,
    minRole: 'owner',
  });

  return DriveFolderAccessRepository.getAccesses({
    filters: {
      project_id: project._id,
      folder_id: folder._id,
      deleted_on: 0,
    },
    sort: { created_on: 1 },
  });
};

const setFolderAccessList = async ({
  user,
  project,
  folder,
  entries,
  replaceExisting = false,
}) => {
  await assertFolderAccess({
    user,
    project,
    folder,
    minRole: 'owner',
  });

  const now = Date.now();
  const normalizedByUser = new Map();

  entries.forEach((entry) => {
    const userId = toIdString(entry.user_id);
    if (!userId) {
      return;
    }
    if (!normalizedByUser.has(userId)) {
      normalizedByUser.set(userId, entry.role);
      return;
    }
    normalizedByUser.set(userId, pickHigherRole(normalizedByUser.get(userId), entry.role));
  });

  const actorUserId = toIdString(user._id);
  if (!normalizedByUser.has(actorUserId)) {
    normalizedByUser.set(actorUserId, 'owner');
  } else if (normalizedByUser.get(actorUserId) !== 'owner') {
    normalizedByUser.set(actorUserId, 'owner');
  }

  let revokedUserIds = [];

  if (replaceExisting) {
    const keepUserIds = Array.from(normalizedByUser.keys());

    // ZL-18489: capture user_ids whose access is about to be revoked, so we can
    // silent-mark their prior unread share notifications as read after the
    // soft-delete. Without this the FE keeps showing a "shared with you" badge
    // for an item the user can no longer see/access.
    const revokedAccessRecords = await DriveFolderAccessRepository.getAccesses({
      filters: {
        project_id: project._id,
        folder_id: folder._id,
        deleted_on: 0,
        user_id: { $nin: keepUserIds },
      },
    });
    revokedUserIds = revokedAccessRecords
      .map((r) => (r.user_id?._id ? r.user_id._id : r.user_id))
      .filter(Boolean);

    await DriveFolderAccessRepository.updateAccesses({
      filters: {
        project_id: project._id,
        folder_id: folder._id,
        deleted_on: 0,
        user_id: { $nin: keepUserIds },
      },
      data: {
        deleted_on: now,
        updated_on: now,
        updated_by: user._id,
      },
    });
  }

  await Promise.all(
    Array.from(normalizedByUser.entries()).map(([userId, role]) =>
      DriveFolderAccessRepository.upsertAccess({
        filters: {
          project_id: project._id,
          folder_id: folder._id,
          user_id: userId,
          deleted_on: 0,
        },
        data: {
          project_id: project._id,
          folder_id: folder._id,
          user_id: userId,
          role,
          inherited: false,
          created_by: user._id,
          updated_by: user._id,
          created_on: now,
          updated_on: now,
          deleted_on: 0,
        },
      })
    )
  );

  // Notify new recipients about folder sharing
  const newReceiverIds = Array.from(normalizedByUser.keys())
    .filter((id) => id !== toIdString(user._id));

  if (newReceiverIds.length > 0) {
    // Build dynamic ancestor-chain levels so shared folders at depth > 1 surface under
    // their root ancestor (level_1) → ... → the shared folder itself at the deepest level.
    // Fixes the ZL-* report where level_2/level_3 were always null for child folders.
    // Wrapped in the existing try/catch so any levels-resolution or FCM failure is logged
    // and swallowed — the share DB write already succeeded above, API must still return 200.
    try {
      const shareLevels = await DriveNotificationReceivers.buildNotificationLevels({
        project,
        folderId: folder._id,
        itemId: folder._id,
      });

      // ZL-18486: silently mark prior unread `drive_folder_shared` for this folder +
      // these receivers as read, then emit `notification:silent` carrying those
      // prior notification_uuids in reference_data.read_notification_ids so the
      // FE badge cache (badgeDB.removeBadgesFromDB at AllBadges.jsx:341-353)
      // can drop them before we fire the new share notification.
      const priorShareFilters = {
        project_id: project._id,
        receiver: { $in: newReceiverIds },
        reference_id: toIdString(folder._id),
        action: 'drive_folder_shared',
        message_read: false,
      };

      const priorReadIds = await NotificationRepository.getNotificationIDs({
        filters: priorShareFilters,
        field: 'notification_uuid',
      });

      if (priorReadIds.length > 0) {
        await NotificationRepository.updateNotification({
          filters: priorShareFilters,
          data: { message_read: true },
        });

        await NotificationService.notifyAll(
          {
            project,
            sender: user._id,
            receiver: newReceiverIds,
            section: sections.TOOLS,
            tool: DRIVE_TOOL,
            unit: DRIVE_UNIT_FOLDER,
            action: 'drive_folder_shared',
            reference_id: shareLevels.reference_id,
            level_1: shareLevels.level_1,
            level_2: shareLevels.level_2,
            level_3: shareLevels.level_3,
            levels: shareLevels.levels,
            reference_data: {
              folder_id: toIdString(folder._id),
              folder_name: folder.folder_name,
              read_notification_ids: priorReadIds.filter(Boolean),
            },
          },
          { save: false, silent: true },
          socketClient,
        );
      }

      await NotificationService.notifyAll(
        {
          project,
          sender: user._id,
          receiver: newReceiverIds,
          section: sections.TOOLS,
          tool: DRIVE_TOOL,
          unit: DRIVE_UNIT_FOLDER,
          action: 'drive_folder_shared',
          reference_id: shareLevels.reference_id,
          level_1: shareLevels.level_1,
          level_2: shareLevels.level_2,
          level_3: shareLevels.level_3,
          levels: shareLevels.levels,
          reference_data: {
            folder_id: toIdString(folder._id),
            folder_name: folder.folder_name,
          },
          message: `Folder "${folder.folder_name}" shared with you`,
        },
        { notify: true, save: true },
        socketClient,
      );
    } catch (notifErr) {
      console.error('[driveAccess] Folder share notification error:', notifErr.message);
    }

    socketClient('__admin_events__', {
      event: 'drive:folder:shared',
      room: `${project._id.toString()}_room`,
      data: {
        project_id: project._id,
        folder,
        shared_with: newReceiverIds,
      },
    });
  }

  // ZL-18489: for users whose access was just revoked, silent-mark their prior
  // unread `drive_folder_shared` notifications as read so the badge disappears
  // along with the access. No save+notify here — the user lost access; we don't
  // want to add a fresh badge on top.
  if (revokedUserIds.length > 0) {
    try {
      const revokedFilters = {
        project_id: project._id,
        receiver: { $in: revokedUserIds },
        reference_id: toIdString(folder._id),
        action: 'drive_folder_shared',
        message_read: false,
      };

      const revokedReadIds = await NotificationRepository.getNotificationIDs({
        filters: revokedFilters,
        field: 'notification_uuid',
      });

      if (revokedReadIds.length > 0) {
        await NotificationRepository.updateNotification({
          filters: revokedFilters,
          data: { message_read: true },
        });

        await NotificationService.notifyAll(
          {
            project,
            sender: user._id,
            receiver: revokedUserIds,
            section: sections.TOOLS,
            tool: DRIVE_TOOL,
            unit: DRIVE_UNIT_FOLDER,
            action: 'drive_folder_shared',
            reference_id: toIdString(folder._id),
            reference_data: {
              folder_id: toIdString(folder._id),
              folder_name: folder.folder_name,
              read_notification_ids: revokedReadIds.filter(Boolean),
            },
          },
          { save: false, silent: true },
          socketClient,
        );
      }
    } catch (err) {
      console.error('[folder_access_revoke_silent_failed]:', err.message);
    }
  }

  return getFolderAccessList({
    user,
    project,
    folder,
  });
};

const inheritFolderAccessToDescendants = async ({ user, project, folder }) => {
  await assertFolderAccess({
    user,
    project,
    folder,
    minRole: 'owner',
  });

  const sourceAccesses = await DriveFolderAccessRepository.getAccesses({
    filters: {
      project_id: project._id,
      folder_id: folder._id,
      deleted_on: 0,
    },
    sort: { created_on: 1 },
  });

  if (sourceAccesses.length === 0) {
    return {
      updatedFolders: 0,
      inheritedEntries: 0,
    };
  }

  const descendantIds = await collectDescendantFolderIds({
    projectId: project._id,
    rootFolderId: folder._id,
    includeRoot: false,
  });

  if (descendantIds.length === 0) {
    return {
      updatedFolders: 0,
      inheritedEntries: 0,
    };
  }

  const sourceUserIds = Array.from(
    new Set(sourceAccesses.map((item) => toIdString(item.user_id)).filter(Boolean))
  );

  const existingAccesses = sourceUserIds.length > 0
    ? await DriveFolderAccessRepository.getAccesses({
        filters: {
          project_id: project._id,
          folder_id: { $in: descendantIds },
          user_id: { $in: sourceUserIds },
          deleted_on: 0,
        },
        sort: { created_on: 1 },
      })
    : [];

  const explicitAccessKeySet = new Set(
    existingAccesses
      .filter((item) => item && !item.inherited)
      .map((item) => `${toIdString(item.folder_id)}:${toIdString(item.user_id)}`)
  );

  const now = Date.now();
  const upserts = [];

  descendantIds.forEach((descendantId) => {
    sourceAccesses.forEach((accessItem) => {
      const sourceUserId = toIdString(accessItem.user_id);
      if (!sourceUserId) {
        return;
      }

      const accessKey = `${toIdString(descendantId)}:${sourceUserId}`;
      if (explicitAccessKeySet.has(accessKey)) {
        return;
      }

      upserts.push(
        DriveFolderAccessRepository.upsertAccess({
          filters: {
            project_id: project._id,
            folder_id: descendantId,
            user_id: accessItem.user_id,
            deleted_on: 0,
          },
          data: {
            project_id: project._id,
            folder_id: descendantId,
            user_id: accessItem.user_id,
            role: accessItem.role,
            inherited: true,
            created_by: user._id,
            updated_by: user._id,
            created_on: now,
            updated_on: now,
            deleted_on: 0,
          },
        })
      );
    });
  });

  if (upserts.length > 0) {
    await Promise.all(upserts);
  }

  return {
    updatedFolders: descendantIds.length,
    inheritedEntries: upserts.length,
  };
};

const softDeleteFolderAccess = ({ projectId, folderIds, data }) =>
  DriveFolderAccessRepository.updateAccesses({
    filters: {
      project_id: projectId,
      folder_id: { $in: folderIds },
      deleted_on: 0,
    },
    data,
  });

const restoreFolderAccess = ({ projectId, folderIds, data }) =>
  DriveFolderAccessRepository.updateAccesses({
    filters: {
      project_id: projectId,
      folder_id: { $in: folderIds },
      deleted_on: { $gt: 0 },
    },
    data,
  });

export default {
  assertFolderAccess,
  resolveFolderRole,
  listAccessibleFolderIds,
  collectDescendantFolderIds,
  getFolderOrNull,
  seedFolderAccess,
  getFolderAccessList,
  setFolderAccessList,
  inheritFolderAccessToDescendants,
  softDeleteFolderAccess,
  restoreFolderAccess,
};
