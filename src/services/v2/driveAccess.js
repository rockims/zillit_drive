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

  // ZL-18885: which folders the user can genuinely reach (owns or was directly
  // granted). Used to bound the ancestor walk for OWNED seeds so a folder that
  // someone else relocated into their private folder does not leak that
  // inaccessible parent into the user's listing (it would show in a tab and
  // 403 on open). File-access / directly-granted seeds keep the original
  // full-path walk so navigation to a shared file's container still works.
  const ownedSet = new Set(ownFolders.map((f) => toIdString(f._id)).filter(Boolean));
  const navAccessibleSet = new Set([
    ...ownedSet,
    ...directIds.map((id) => toIdString(id)).filter(Boolean),
  ]);

  // Walk up from each seed folder to root, adding ancestors
  for (const seedId of seedIds) {
    // For a folder the user OWNS, only surface ancestors they can actually
    // access — stop at the first foreign parent instead of exposing it. All of
    // an owner's accessible ancestors are already seeds (owned/granted), so this
    // never drops a reachable folder; it only re-anchors an orphaned folder to
    // the user's root. Non-owned seeds keep the unconditional walk (unchanged).
    const restrictToAccessible = ownedSet.has(seedId);
    let current = folderMap.get(seedId);
    while (current && !allIds.has(current) && !ancestorIds.has(current)) {
      if (restrictToAccessible && !navAccessibleSet.has(current)) break;
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
  // Reading the access list — "who else has this folder?" — is a
  // view-level operation, not an owner-level one. The file analog
  // (getFileAccess in driveFileAccess.js) explicitly requires only
  // `view` with the comment "User needs at least view permission to
  // see access list". The folder side was bootstrapped to `owner` and
  // never re-examined; that made FileDetailsPanel work for files but
  // 403 for folders in the SAME panel for the same editor/viewer.
  // Modifying the list (setFolderAccessList, below) still requires
  // owner — write semantics are unchanged. (The list responses already
  // expose _accessUserIds / _accessCount to viewers + editors, so this
  // closes the parity gap without revealing materially new info.)
  await assertFolderAccess({
    user,
    project,
    folder,
    minRole: 'viewer',
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
    // ZL-18798: share recipients are BY DEFINITION sharees (they just got
    // shared into this folder for the first time). Always route to the
    // Shared with Me tab — parentFolderOwnerId=null forces every receiver
    // into the sharees bucket.
    try {
      // Dedup per recipient: if a recipient already has an UNREAD
      // `drive_folder_shared` notification for this folder whose stored
      // folder_name matches the current folder_name, their existing
      // badge is still accurate — skip firing a fresh one. Otherwise
      // (no pending notif, or pending notif text is stale because the
      // folder was renamed since), include them in the refresh flow
      // below. Without this dedup, every re-save of the access list —
      // even an unchanged one — created another "shared with you"
      // notification for already-included users (reported: "I get
      // 'shared with you' twice if they update it twice").
      const pendingFilters = {
        project_id: project._id,
        receiver: { $in: newReceiverIds },
        reference_id: toIdString(folder._id),
        action: 'drive_folder_shared',
        message_read: false,
      };
      const pendingNotifs = await NotificationRepository.getNotifications({
        filters: pendingFilters,
      });
      const upToDateReceivers = new Set(
        pendingNotifs
          .filter((n) => (n?.reference_data?.folder_name || '') === folder.folder_name)
          .map((n) => toIdString(n.receiver)),
      );
      const receiverIdsToRefresh = newReceiverIds.filter(
        (id) => !upToDateReceivers.has(toIdString(id)),
      );

      if (receiverIdsToRefresh.length > 0) {
        // ZL-18486: silently mark prior unread `drive_folder_shared` for this folder +
        // the to-refresh receivers as read, then emit `notification:silent` carrying
        // those prior notification_uuids in reference_data.read_notification_ids so
        // the FE badge cache (badgeDB.removeBadgesFromDB at AllBadges.jsx:341-353)
        // can drop them before we fire the new share notification.
        const priorShareFilters = {
          project_id: project._id,
          receiver: { $in: receiverIdsToRefresh },
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

          await DriveNotificationReceivers.notifyAllTabRouted({
            project,
            actor: user,
            receiverIds: receiverIdsToRefresh,
            // ZL-18885: the folder OWNER (created_by) is routed to My Drive;
            // genuine new sharees fall through to Shared With Me. Previously
            // null sent EVERYONE — including the owner (e.g. when the FE
            // re-sends the full access list) — to Shared With Me.
            parentFolderOwnerId: toIdString(folder.created_by),
            folderId: folder._id,
            itemId: folder._id,
            unit: DRIVE_UNIT_FOLDER,
            action: 'drive_folder_shared',
            referenceData: {
              folder_id: toIdString(folder._id),
              folder_name: folder.folder_name,
              read_notification_ids: priorReadIds.filter(Boolean),
            },
            socketClient,
            options: { save: false, silent: true },
          });
        }

        await DriveNotificationReceivers.notifyAllTabRouted({
          project,
          actor: user,
          receiverIds: receiverIdsToRefresh,
          // ZL-18885: owner → My Drive; genuine new sharees → Shared With Me.
          parentFolderOwnerId: toIdString(folder.created_by),
          folderId: folder._id,
          itemId: folder._id,
          unit: DRIVE_UNIT_FOLDER,
          action: 'drive_folder_shared',
          message: `Folder "${folder.folder_name}" shared with you`,
          referenceData: {
            folder_id: toIdString(folder._id),
            folder_name: folder.folder_name,
          },
          socketClient,
        });
      }
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

        // ZL-18798: revoked users had Shared with Me badges; silent-mark
        // must match that tab so the FE drops them from the right bucket.
        await DriveNotificationReceivers.notifyAllTabRouted({
          project,
          actor: user,
          receiverIds: revokedUserIds,
          parentFolderOwnerId: null, // sharees only (the folder is now NOT shared with them)
          folderId: folder._id,
          itemId: folder._id,
          unit: DRIVE_UNIT_FOLDER,
          action: 'drive_folder_shared',
          referenceData: {
            folder_id: toIdString(folder._id),
            folder_name: folder.folder_name,
            read_notification_ids: revokedReadIds.filter(Boolean),
          },
          socketClient,
          options: { save: false, silent: true },
        });
      }
    } catch (err) {
      console.error('[folder_access_revoke_silent_failed]:', err.message);
    }

    // ZL-19251 / ZL-19248: counterpart to the `drive:folder:shared`
    // emit above. Without this, revoking a folder share went silent
    // on the socket bus — the sharer's "Shared By Me" filter stayed
    // stale until they manually refreshed (the symptom Vishal
    // reported on 2026-05-25). Mirrors the shared-event's shape:
    // same channel (__admin_events__), same project room, same
    // `data.folder` payload; switches `shared_with` →
    // `unshared_from` and uses `:unshared` for the event verb.
    socketClient('__admin_events__', {
      event: 'drive:folder:unshared',
      room: `${project._id.toString()}_room`,
      data: {
        project_id: project._id,
        folder,
        unshared_from: revokedUserIds.map((id) => id.toString()),
      },
    });
  }

  return getFolderAccessList({
    user,
    project,
    folder,
  });
};

const inheritFolderAccessToDescendants = async ({
  user, project, folder, skipAccessCheck = false,
}) => {
  // ZL-20162: the standalone POST /:folderId/access/inherit endpoint is
  // owner-only, so this asserts owner by default. But moveFolder calls this
  // internally AFTER it has already authorized the actor (editor on the
  // target). Re-asserting owner there re-blocked an editor's already-valid
  // move — and, because the throw landed AFTER the parent_folder_id mutation,
  // the move persisted while the request 403'd. moveFolder passes
  // skipAccessCheck:true to bypass this redundant gate; every other caller
  // keeps the owner check. This copies only the TARGET's existing ACL down to
  // its descendants — it grants the actor nothing new, so it's not an
  // escalation.
  if (!skipAccessCheck) {
    await assertFolderAccess({
      user,
      project,
      folder,
      minRole: 'owner',
    });
  }

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
