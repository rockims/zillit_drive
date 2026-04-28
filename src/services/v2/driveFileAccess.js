import Forbidden from 'zillit-libs/errors/Forbidden';
import BadRequest from 'zillit-libs/errors/BadRequest';
import { rights } from 'zillit-libs/services-v2/permissions';
import NotificationService from 'zillit-libs/services-v2/notification';
import NotificationRepository from 'zillit-libs/repositories-v2/notification';

import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFileAccessRepository from '../../repositories/v2/driveFileAccess.js';
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
        .map((entry) =>
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
              can_view: entry.can_view !== undefined ? entry.can_view : true,
              can_edit: entry.can_edit !== undefined ? entry.can_edit : false,
              can_download: entry.can_download !== undefined ? entry.can_download : true,
              can_delete: entry.can_delete !== undefined ? entry.can_delete : false,
              granted_by: grantedBy,
              created_on: now,
              updated_on: now,
              deleted_on: 0,
            },
          }),
        ),
    );
  }

  // Root-level files are only accessible to the uploader and explicitly shared users.
  // No auto-grant to all project members — access is controlled via explicit file-level permissions.
};

/* ───────────── Get File Access List ───────────── */

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

  return DriveFileAccessRepository.getAccesses({
    filters: {
      project_id: project._id,
      file_id: fileId,
      deleted_on: 0,
    },
    sort: { created_on: 1 },
  });
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
      can_view: entry.can_view !== undefined ? entry.can_view : true,
      can_edit: entry.can_edit !== undefined ? entry.can_edit : false,
      can_download: entry.can_download !== undefined ? entry.can_download : true,
      can_delete: entry.can_delete !== undefined ? entry.can_delete : false,
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
  getFileAccess,
  setFileAccessList,
};
