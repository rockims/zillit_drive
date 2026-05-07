import Forbidden from 'zillit-libs/errors/Forbidden';
import BadRequest from 'zillit-libs/errors/BadRequest';
import { rights } from 'zillit-libs/services-v2/permissions';
import NotificationService from 'zillit-libs/services-v2/notification';
import NotificationRepository from 'zillit-libs/repositories-v2/notification';
import DriveFolder from 'zillit-libs/mongo-models-v2/DriveFolder';

import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFileAccessRepository from '../../repositories/v2/driveFileAccess.js';
import DriveFolderAccessRepository from '../../repositories/v2/driveFolderAccess.js';
import DriveAccessService from './driveAccess.js';
import DriveNotificationReceivers from './driveNotificationReceivers.js';
import socketClient from '../../config/socketClient.js';

const { sections } = NotificationService.NotificationConstants;
const DRIVE_TOOL = 'drive_label';
const DRIVE_UNIT_FILE = 'drive_file_label';

const toIdString = (value) => (value ? value.toString() : null);

/**
 * Map folder-level role to file-level permissions.
 * Used as fallback when no DriveFileAccess record exists.
 */
const ROLE_TO_PERMISSIONS = {
  owner: { can_view: true, can_edit: true, can_download: true, can_delete: true },
  editor: { can_view: true, can_edit: true, can_download: true, can_delete: false },
  viewer: { can_view: true, can_edit: false, can_download: false, can_delete: false },
};

// ZL-18808: enforce that edit/download/delete depend on view. Edit access
// without view is incoherent and would let a client (iOS/web/Android)
// reach the edit/download endpoints (which only check can_edit/can_download)
// for a user who has no view access. Coerce dependents to false on every
// write path.
const normalizePermissions = (entry = {}) => {
  const canView = entry.can_view !== undefined ? entry.can_view : true;
  if (!canView) {
    return {
      can_view: false, can_edit: false, can_download: false, can_delete: false,
    };
  }
  return {
    can_view: true,
    can_edit: entry.can_edit !== undefined ? entry.can_edit : false,
    can_download: entry.can_download !== undefined ? entry.can_download : true,
    can_delete: entry.can_delete !== undefined ? entry.can_delete : false,
  };
};

/* ───────────── Resolve File Permission ───────────── */

/**
 * Resolves a user's effective permissions on a file.
 * 1. Check DriveFileAccess record (explicit file-level permissions)
 * 2. Fall back to folder-level role via DriveAccessService.resolveFolderRole()
 * 3. Admin → full permissions
 *
 * @returns {{ can_view: boolean, can_edit: boolean, can_download: boolean } | null}
 */
const resolveFilePermission = async ({ user, project, file }) => {
  if (!user || !project || !file) return null;

  // File creator/uploader ALWAYS gets full access (owner) — check first
  const userId = toIdString(user._id);
  if (toIdString(file.created_by) === userId || toIdString(file.uploaded_by) === userId) {
    return { can_view: true, can_edit: true, can_download: true, can_delete: true };
  }

  // Check explicit file-level access for non-creators
  const fileAccess = await DriveFileAccessRepository.getAccess({
    filters: {
      project_id: project._id,
      file_id: file._id,
      user_id: user._id,
      deleted_on: 0,
    },
  });

  if (fileAccess) {
    return {
      can_view: fileAccess.can_view,
      can_edit: fileAccess.can_edit,
      can_download: fileAccess.can_download,
      can_delete: fileAccess.can_delete || false,
    };
  }

  // Fall back to folder-level permissions
  if (file.folder_id) {
    const DriveFolderRepository = (await import('../../repositories/v2/driveFolder.js')).default;
    const folder = await DriveFolderRepository.getFolder({
      filters: {
        _id: file.folder_id,
        project_id: project._id,
        deleted_on: 0,
      },
    });

    if (folder) {
      const role = await DriveAccessService.resolveFolderRole({ user, project, folder });
      if (role && ROLE_TO_PERMISSIONS[role]) {
        return { ...ROLE_TO_PERMISSIONS[role] };
      }
    }
  }

  return null;
};

/* ───────────── Assert File Access ───────────── */

/**
 * Assert that a user has a specific permission on a file.
 * @param {string} permission — 'view' | 'edit' | 'download'
 */
const assertFileAccess = async ({ user, project, file, permission = 'view' }) => {
  const permissions = await resolveFilePermission({ user, project, file });

  if (!permissions) {
    throw new Forbidden('insufficient_permissions');
  }

  const permissionKey = `can_${permission}`;
  if (!permissions[permissionKey]) {
    throw new Forbidden('insufficient_permissions');
  }
};

/* ───────────── Seed File Access ───────────── */

/**
 * Called after file creation. Creates access records for the uploader
 * and any additional entries specified during upload.
 */
const seedFileAccess = async ({ project, user, file, entries = [] }) => {
  const now = Date.now();
  const projectId = project._id;
  const fileId = file._id;
  const grantedBy = user._id;

  // Always create full-access record for the uploader (owner — can_delete: true)
  await DriveFileAccessRepository.upsertAccess({
    filters: {
      project_id: projectId,
      file_id: fileId,
      user_id: user._id,
      deleted_on: 0,
    },
    data: {
      project_id: projectId,
      file_id: fileId,
      user_id: user._id,
      can_view: true,
      can_edit: true,
      can_download: true,
      can_delete: true,
      granted_by: grantedBy,
      created_on: now,
      updated_on: now,
      deleted_on: 0,
    },
  });

  // Create entries for explicitly specified users (editors — can_delete defaults to false)
  if (entries.length > 0) {
    await Promise.all(
      entries
        .filter((entry) => toIdString(entry.user_id) !== toIdString(user._id))
        .map((entry) => {
          const perms = normalizePermissions(entry);
          return DriveFileAccessRepository.upsertAccess({
            filters: {
              project_id: projectId,
              file_id: fileId,
              user_id: entry.user_id,
              deleted_on: 0,
            },
            data: {
              project_id: projectId,
              file_id: fileId,
              user_id: entry.user_id,
              can_view: perms.can_view,
              can_edit: perms.can_edit,
              can_download: perms.can_download,
              can_delete: perms.can_delete,
              granted_by: grantedBy,
              created_on: now,
              updated_on: now,
              deleted_on: 0,
            },
          });
        }),
    );
  }

  // Root-level files are only accessible to the uploader and explicitly shared users.
  // No auto-grant to all project members — access is controlled via explicit file-level permissions.
};

/* ───────────── Snapshot Folder ACL onto File ───────────── */

/**
 * Persist the target folder's explicit ACL onto a file as concrete
 * DriveFileAccess records. Used after `moveFile` / `bulkMove` so a file
 * dropped into a shared folder picks up that folder's members in the
 * file's "shared with" list — not just at the runtime fallback layer
 * (resolveFilePermission already reads through to the folder, but the
 * file's access endpoint and any FE that lists per-file ACL won't know
 * about those users without explicit records).
 *
 * Rules:
 *   - Skip the actor (they're already the owner via seedFileAccess).
 *   - Skip any user who already has an explicit DriveFileAccess record on
 *     this file — never downgrade or overwrite a permission that was
 *     deliberately granted (e.g. coord previously set User B to viewer
 *     on this file; folder grants editor; we keep B's viewer).
 *   - Map the folder role to file permissions via ROLE_TO_PERMISSIONS
 *     (same map runtime fallback uses, so behavior is consistent).
 *   - No-op when target folder has zero members — e.g. moving to a folder
 *     no one else has been shared on.
 *
 * Called from moveFile / bulkMove. Wrapped in the caller's try/catch so
 * the move itself never fails because of an ACL snapshot hiccup — the
 * file is already at its new folder_id, so a missing snapshot just means
 * inheritance falls back to runtime resolution (the prior behavior).
 */
const snapshotFolderAccessToFile = async ({
  project, file, folder, actorId,
}) => {
  if (!folder) return;

  const folderAccesses = await DriveFolderAccessRepository.getAccesses({
    filters: {
      project_id: project._id,
      folder_id: folder._id,
      deleted_on: 0,
    },
  });

  if (!folderAccesses.length) return;

  const actorIdStr = toIdString(actorId);
  const now = Date.now();

  await Promise.all(folderAccesses.map(async (folderAccess) => {
    // getAccesses populates user_id, so unwrap the populated subdoc
    const folderUserId = folderAccess.user_id?._id
      ? folderAccess.user_id._id
      : folderAccess.user_id;
    if (!folderUserId) return;

    if (toIdString(folderUserId) === actorIdStr) return;

    // Don't overwrite an explicit existing record on this file
    const existing = await DriveFileAccessRepository.getAccess({
      filters: {
        project_id: project._id,
        file_id: file._id,
        user_id: folderUserId,
        deleted_on: 0,
      },
    });
    if (existing) return;

    const permissions = ROLE_TO_PERMISSIONS[folderAccess.role]
      || ROLE_TO_PERMISSIONS.viewer;

    await DriveFileAccessRepository.upsertAccess({
      filters: {
        project_id: project._id,
        file_id: file._id,
        user_id: folderUserId,
        deleted_on: 0,
      },
      data: {
        project_id: project._id,
        file_id: file._id,
        user_id: folderUserId,
        can_view: permissions.can_view,
        can_edit: permissions.can_edit,
        can_download: permissions.can_download,
        can_delete: permissions.can_delete,
        granted_by: actorId,
        created_on: now,
        updated_on: now,
        deleted_on: 0,
      },
    });
  }));
};

/* ───────────── Get File Access List ───────────── */

/**
 * Resolve the ordered ancestor folder chain (closest parent first) for a file.
 * Returns [parentFolderId, parentOfParent, ...] up to the root, or [] if no parent.
 * Mirrors the $graphLookup pattern in driveAccess.js::resolveFolderRole so a deep
 * file at /a/b/c/file.txt picks up grants made at any ancestor level.
 */
const _resolveAncestorFolderIds = async ({ project, folder }) => {
  if (!folder) return [];

  const ordered = [folder._id];
  if (!folder.parent_folder_id) return ordered;

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
    { $project: { ancestors: { _id: 1, parent_folder_id: 1 } } },
  ]);

  const ancestors = result?.ancestors || [];
  if (ancestors.length === 0) return ordered;

  const ancestorMap = new Map();
  ancestors.forEach((a) => ancestorMap.set(toIdString(a._id), a));

  const visited = new Set([toIdString(folder._id)]);
  let nextParentId = toIdString(folder.parent_folder_id);
  while (nextParentId && !visited.has(nextParentId)) {
    visited.add(nextParentId);
    const ancestor = ancestorMap.get(nextParentId);
    if (!ancestor) break;
    ordered.push(ancestor._id);
    nextParentId = toIdString(ancestor.parent_folder_id);
  }

  return ordered;
};

/**
 * ZL-18804/-18805: project folder-level access records onto a file as
 * synthesized DriveFileAccess-shaped entries so the access list endpoint
 * surfaces users who only have access via the parent folder (or any ancestor).
 *
 * Rules:
 *   - Walk file.folder_id and its ancestor chain (closest first).
 *   - Skip users who already have an explicit DriveFileAccess record on the
 *     file — explicit always wins.
 *   - Closer ancestor wins on conflicts (matches resolveFolderRole semantics).
 *   - Map folder role to file permissions via ROLE_TO_PERMISSIONS.
 *   - Tag entries with `inherited: true` + `inherited_from_folder_id` so the
 *     FE can render them differently (e.g. badge "via folder", disable edit
 *     in the file's share UI; user must edit on the folder instead).
 */
const _getInheritedFileAccessFromFolders = async ({ project, file, explicitAccess }) => {
  if (!file?.folder_id) return [];

  const DriveFolderRepository = (await import('../../repositories/v2/driveFolder.js')).default;
  const folder = await DriveFolderRepository.getFolder({
    filters: {
      _id: file.folder_id,
      project_id: project._id,
      deleted_on: 0,
    },
  });
  if (!folder) return [];

  const orderedFolderIds = await _resolveAncestorFolderIds({ project, folder });
  if (orderedFolderIds.length === 0) return [];

  const folderAccesses = await DriveFolderAccessRepository.getAccesses({
    filters: {
      project_id: project._id,
      folder_id: { $in: orderedFolderIds },
      deleted_on: 0,
    },
  });
  if (folderAccesses.length === 0) return [];

  const explicitUserIds = new Set(
    explicitAccess
      .map((a) => toIdString(a.user_id?._id ? a.user_id._id : a.user_id))
      .filter(Boolean),
  );

  // Index folder accesses by folder_id for closest-first resolution
  const accessesByFolderId = new Map();
  folderAccesses.forEach((fa) => {
    const fId = toIdString(fa.folder_id?._id ? fa.folder_id._id : fa.folder_id);
    if (!fId) return;
    if (!accessesByFolderId.has(fId)) accessesByFolderId.set(fId, []);
    accessesByFolderId.get(fId).push(fa);
  });

  const seenUserIds = new Set();
  const inheritedEntries = [];

  // Walk closest ancestor first — first hit wins per user
  for (const folderId of orderedFolderIds) {
    const accesses = accessesByFolderId.get(toIdString(folderId)) || [];
    for (const fa of accesses) {
      const userId = toIdString(fa.user_id?._id ? fa.user_id._id : fa.user_id);
      if (!userId) continue;
      if (explicitUserIds.has(userId)) continue;
      if (seenUserIds.has(userId)) continue;
      seenUserIds.add(userId);

      const perms = ROLE_TO_PERMISSIONS[fa.role] || ROLE_TO_PERMISSIONS.viewer;
      inheritedEntries.push({
        _id: fa._id,
        file_id: file._id,
        project_id: project._id,
        user_id: fa.user_id,
        can_view: perms.can_view,
        can_edit: perms.can_edit,
        can_download: perms.can_download,
        can_delete: perms.can_delete,
        granted_by: fa.created_by || null,
        created_on: fa.created_on,
        updated_on: fa.updated_on,
        deleted_on: 0,
        inherited: true,
        inherited_from_folder_id: toIdString(fa.folder_id?._id ? fa.folder_id._id : fa.folder_id),
      });
    }
  }

  return inheritedEntries;
};

const getFileAccess = async ({ user, project, fileId }) => {
  const file = await DriveFileRepository.getFile({
    filters: {
      _id: fileId,
      project_id: project._id,
      deleted_on: 0,
    },
  });

  if (!file) throw new BadRequest('file_not_found');

  // User needs at least view permission to see access list
  await assertFileAccess({ user, project, file, permission: 'view' });

  const explicitAccess = await DriveFileAccessRepository.getAccesses({
    filters: {
      project_id: project._id,
      file_id: fileId,
      deleted_on: 0,
    },
    sort: { created_on: 1 },
  });

  // ZL-18804/-18805: union folder-level inherited access. Wrapped in try/catch
  // so any folder-walk failure logs and falls back to the original (explicit-only)
  // behavior — never 500 the access list.
  let inheritedAccess = [];
  try {
    inheritedAccess = await _getInheritedFileAccessFromFolders({
      project, file, explicitAccess,
    });
  } catch (err) {
    console.error('[getFileAccess] folder inheritance lookup failed:', err.message);
  }

  return [...explicitAccess, ...inheritedAccess];
};

/* ───────────── Set File Access List ───────────── */

const setFileAccessList = async ({ user, project, fileId, entries }) => {
  const file = await DriveFileRepository.getFile({
    filters: {
      _id: fileId,
      project_id: project._id,
      deleted_on: 0,
    },
  });

  if (!file) throw new BadRequest('file_not_found');

  // Caller needs edit permission to modify access
  await assertFileAccess({ user, project, file, permission: 'edit' });

  const now = Date.now();
  const projectId = project._id;
  const grantedBy = user._id;

  // Ensure the caller retains full access
  const normalizedEntries = new Map();
  entries.forEach((entry) => {
    const userId = toIdString(entry.user_id);
    if (!userId) return;
    normalizedEntries.set(userId, {
      user_id: entry.user_id,
      ...normalizePermissions(entry),
    });
  });

  // Ensure actor keeps full access (owner-level)
  const actorId = toIdString(user._id);
  normalizedEntries.set(actorId, {
    user_id: user._id,
    can_view: true,
    can_edit: true,
    can_download: true,
    can_delete: true,
  });

  // Soft-delete entries for users not in the new list
  const keepUserIds = Array.from(normalizedEntries.keys());

  // ZL-18489: capture user_ids whose access is about to be revoked, so we can
  // silent-mark their prior unread share notifications as read after the
  // soft-delete. Without this the FE keeps showing a "shared with you" badge
  // for an item the user can no longer see/access.
  const revokedAccessRecords = await DriveFileAccessRepository.getAccesses({
    filters: {
      project_id: projectId,
      file_id: fileId,
      deleted_on: 0,
      user_id: { $nin: keepUserIds },
    },
  });
  const revokedUserIds = revokedAccessRecords
    .map((r) => (r.user_id?._id ? r.user_id._id : r.user_id))
    .filter(Boolean);

  await DriveFileAccessRepository.updateAccesses({
    filters: {
      project_id: projectId,
      file_id: fileId,
      deleted_on: 0,
      user_id: { $nin: keepUserIds },
    },
    data: {
      deleted_on: now,
      updated_on: now,
    },
  });

  // Upsert entries
  await Promise.all(
    Array.from(normalizedEntries.values()).map((entry) =>
      DriveFileAccessRepository.upsertAccess({
        filters: {
          project_id: projectId,
          file_id: fileId,
          user_id: entry.user_id,
          deleted_on: 0,
        },
        data: {
          project_id: projectId,
          file_id: fileId,
          user_id: entry.user_id,
          can_view: entry.can_view,
          can_edit: entry.can_edit,
          can_download: entry.can_download,
          can_delete: entry.can_delete || false,
          granted_by: grantedBy,
          updated_on: now,
          deleted_on: 0,
        },
      }),
    ),
  );

  // Notify users who were granted access (excluding the actor)
  const newReceiverIds = Array.from(normalizedEntries.values())
    .filter((e) => toIdString(e.user_id) !== actorId)
    .map((e) => e.user_id);

  if (newReceiverIds.length > 0) {
    // Build ancestor-chain levels from the file's parent folder (level_1 = root, etc.)
    // Matches the file CRUD paths (update/delete/move) for consistent client-side routing.
    // Wrapped in try/catch — share DB write already persisted; never let FCM issues 500 the API.
    try {
      const shareLevels = await DriveNotificationReceivers.buildNotificationLevels({
        project,
        folderId: file.folder_id,
        itemId: file._id,
      });
      const folderId = file.folder_id ? toIdString(file.folder_id) : null;

      // ZL-18486: silently mark prior unread `drive_file_shared` for this file +
      // these receivers as read, then emit `notification:silent` carrying those
      // prior notification_uuids in reference_data.read_notification_ids so the
      // FE badge cache (badgeDB.removeBadgesFromDB at AllBadges.jsx:341-353)
      // can drop them before we fire the new share notification.
      const priorShareFilters = {
        project_id: project._id,
        receiver: { $in: newReceiverIds },
        reference_id: toIdString(file._id),
        action: 'drive_file_shared',
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
            unit: DRIVE_UNIT_FILE,
            action: 'drive_file_shared',
            reference_id: shareLevels.reference_id,
            level_1: shareLevels.level_1,
            level_2: shareLevels.level_2,
            level_3: shareLevels.level_3,
            levels: shareLevels.levels,
            reference_data: {
              file_id: toIdString(file._id),
              file_name: file.file_name,
              folder_id: folderId,
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
          unit: DRIVE_UNIT_FILE,
          action: 'drive_file_shared',
          reference_id: shareLevels.reference_id,
          level_1: shareLevels.level_1,
          level_2: shareLevels.level_2,
          level_3: shareLevels.level_3,
          levels: shareLevels.levels,
          reference_data: {
            file_id: toIdString(file._id),
            file_name: file.file_name,
            folder_id: folderId,
          },
          message: `File "${file.file_name}" shared with you`,
        },
        { notify: true, save: true },
        socketClient,
      );
    } catch (err) {
      console.error('[file_access_notification_failed]:', err.message);
    }

    socketClient('__admin_events__', {
      event: 'drive:file:shared',
      room: `${project._id.toString()}_room`,
      data: {
        project_id: project._id,
        file,
        shared_with: newReceiverIds.map((id) => id.toString()),
      },
    });
  }

  // ZL-18489: for users whose access was just revoked, silent-mark their prior
  // unread `drive_file_shared` notifications as read so the badge disappears
  // along with the access. No save+notify here — the user lost access; we don't
  // want to add a fresh badge on top.
  if (revokedUserIds.length > 0) {
    try {
      const revokedFilters = {
        project_id: project._id,
        receiver: { $in: revokedUserIds },
        reference_id: toIdString(file._id),
        action: 'drive_file_shared',
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
            unit: DRIVE_UNIT_FILE,
            action: 'drive_file_shared',
            reference_id: toIdString(file._id),
            reference_data: {
              file_id: toIdString(file._id),
              file_name: file.file_name,
              read_notification_ids: revokedReadIds.filter(Boolean),
            },
          },
          { save: false, silent: true },
          socketClient,
        );
      }
    } catch (err) {
      console.error('[file_access_revoke_silent_failed]:', err.message);
    }
  }

  return DriveFileAccessRepository.getAccesses({
    filters: {
      project_id: projectId,
      file_id: fileId,
      deleted_on: 0,
    },
    sort: { created_on: 1 },
  });
};

export default {
  resolveFilePermission,
  assertFileAccess,
  seedFileAccess,
  snapshotFolderAccessToFile,
  getFileAccess,
  setFileAccessList,
};
