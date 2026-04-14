import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFolderRepository from '../../repositories/v2/driveFolder.js';
import DriveFileAccessRepository from '../../repositories/v2/driveFileAccess.js';
import DriveAccessService from './driveAccess.js';
import DriveActivityService from './driveActivity.js';
import BadRequest from 'zillit-libs/errors/BadRequest';
import Forbidden from 'zillit-libs/errors/Forbidden';
import socketClient from '../../config/socketClient.js';

/**
 * DriveTrashService — list, restore, and permanently delete soft-deleted items.
 *
 * Soft delete convention:
 *   active  → deleted_on: 0
 *   trashed → deleted_on: <timestamp>
 */

// ───────────────────────────────────────────────────────────
//  List deleted items (files + folders)
// ───────────────────────────────────────────────────────────

const listTrash = async ({ user, project, query }) => {
  const limit = Math.min(parseInt(query?.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(query?.offset, 10) || 0, 0);

  const baseFileFilter = {
    project_id: project._id,
    deleted_on: { $gt: 0 },
  };
  const baseFolderFilter = {
    project_id: project._id,
    deleted_on: { $gt: 0 },
  };

  // Private Drive: each user only sees items THEY created in trash.
  // This matches emptyTrash scope (created_by = user._id) so emptying
  // actually removes everything the user sees — no phantom reappearing items.
  baseFileFilter.created_by = user._id;
  baseFolderFilter.created_by = user._id;

  // Optional search within trash
  if (query?.search) {
    const searchRegex = new RegExp(query.search, 'i');
    baseFileFilter.file_name = searchRegex;
    baseFolderFilter.folder_name = searchRegex;
  }

  const [files, folders, fileCount, folderCount] = await Promise.all([
    DriveFileRepository.getFiles({
      filters: baseFileFilter,
      sort: { deleted_on: -1 },
      limit,
      skip: offset,
    }),
    DriveFolderRepository.getFolders({
      filters: baseFolderFilter,
      sort: { deleted_on: -1 },
      limit,
      skip: offset,
    }),
    DriveFileRepository.countFiles({ filters: baseFileFilter }),
    DriveFolderRepository.countFolders({ filters: baseFolderFilter }),
  ]);

  // Merge and sort by deleted_on desc
  const items = [
    ...files.map((f) => ({
      ...f.toObject(),
      item_type: 'file',
      name: f.file_name,
    })),
    ...folders.map((f) => ({
      ...f.toObject(),
      item_type: 'folder',
      name: f.folder_name,
    })),
  ].sort((a, b) => b.deleted_on - a.deleted_on);

  return {
    items,
    total: fileCount + folderCount,
    limit,
    offset,
  };
};

// ───────────────────────────────────────────────────────────
//  Restore a trashed item
// ───────────────────────────────────────────────────────────

const restoreItem = async ({ user, project, device, params }) => {
  const { itemId } = params;
  const { type } = params; // 'file' or 'folder'

  const now = Date.now();
  const restoreData = {
    deleted_on: 0,
    updated_by: user._id,
    updated_on: now,
  };

  if (type === 'folder') {
    // Restore the folder
    const folder = await DriveFolderRepository.getFolder({
      filters: { _id: itemId, project_id: project._id, deleted_on: { $gt: 0 } },
    });

    if (!folder) {
      throw new BadRequest('folder_not_found_in_trash');
    }

    // Only the folder creator can restore it
    if (String(folder.created_by) !== String(user._id)) {
      throw new Forbidden('insufficient_permissions_to_restore');
    }

    // If it has a parent, make sure the parent is not also deleted
    if (folder.parent_folder_id) {
      const parent = await DriveFolderRepository.getFolder({
        filters: { _id: folder.parent_folder_id, project_id: project._id, deleted_on: 0 },
      });
      if (!parent) {
        // Parent is also deleted or doesn't exist — restore to root
        restoreData.parent_folder_id = null;
        restoreData.folder_path = `/${folder.folder_name}`;
      }
    }

    // Restore the folder itself
    await DriveFolderRepository.updateFolder({
      filters: { _id: itemId, project_id: project._id },
      data: restoreData,
    });

    // Restore all descendant folders and their files
    const descendantFolderIds = await DriveAccessService.collectDescendantFolderIds({
      projectId: project._id,
      rootFolderId: folder._id,
      includeRoot: false,
    });

    if (descendantFolderIds.length > 0) {
      await Promise.all([
        DriveFolderRepository.updateFolders({
          filters: {
            project_id: project._id,
            _id: { $in: descendantFolderIds },
            deleted_on: folder.deleted_on, // Only restore items deleted at the same time
          },
          data: restoreData,
        }),
        DriveFileRepository.updateFiles({
          filters: {
            project_id: project._id,
            folder_id: { $in: [...descendantFolderIds, folder._id] },
            deleted_on: folder.deleted_on,
          },
          data: restoreData,
        }),
      ]);
    }

    // Also restore files directly in this folder
    await DriveFileRepository.updateFiles({
      filters: {
        project_id: project._id,
        folder_id: folder._id,
        deleted_on: folder.deleted_on,
      },
      data: restoreData,
    });

    // Restore access records
    await DriveAccessService.restoreFolderAccess({
      projectId: project._id,
      folderIds: [folder._id, ...descendantFolderIds],
      data: restoreData,
    });

    socketClient('__admin_events__', {
      event: 'drive:folder:restored',
      room: `${project._id.toString()}_room`,
      data: { project_id: project._id, folder },
    });

    // Activity log (fire-and-forget)
    DriveActivityService.log({
      projectId: project._id, userId: user._id, action: 'folder_restored',
      itemId: folder._id, itemType: 'folder', itemName: folder.folder_name,
    });

    return { message: 'Folder restored successfully', item: folder };
  }

  // Restore a file
  const file = await DriveFileRepository.getFile({
    filters: { _id: itemId, project_id: project._id, deleted_on: { $gt: 0 } },
  });

  if (!file) {
    throw new BadRequest('file_not_found_in_trash');
  }

  // Only the file creator can restore
  if (String(file.created_by) !== String(user._id)) {
    throw new Forbidden('insufficient_permissions_to_restore');
  }

  // If the file's parent folder is deleted, restore to root
  if (file.folder_id) {
    const parentFolder = await DriveFolderRepository.getFolder({
      filters: { _id: file.folder_id, project_id: project._id, deleted_on: 0 },
    });
    if (!parentFolder) {
      restoreData.folder_id = null;
    }
  }

  await DriveFileRepository.updateFile({
    filters: { _id: itemId, project_id: project._id },
    data: restoreData,
  });

  socketClient('__admin_events__', {
    event: 'drive:file:restored',
    room: `${project._id.toString()}_room`,
    data: { project_id: project._id, file },
  });

  // Activity log (fire-and-forget)
  DriveActivityService.log({
    projectId: project._id, userId: user._id, action: 'file_restored',
    itemId: file._id, itemType: 'file', itemName: file.file_name,
  });

  return { message: 'File restored successfully', item: file };
};

// ───────────────────────────────────────────────────────────
//  Permanently delete a trashed item (admin/owner only)
// ───────────────────────────────────────────────────────────

const permanentDelete = async ({ user, project, device, params }) => {
  const { itemId } = params;
  const { type } = params; // 'file' or 'folder'

  if (type === 'folder') {
    const folder = await DriveFolderRepository.getFolder({
      filters: { _id: itemId, project_id: project._id, deleted_on: { $gt: 0 } },
    });

    if (!folder) {
      throw new BadRequest('folder_not_found_in_trash');
    }

    // Only the folder creator can permanently delete
    if (String(folder.created_by) !== String(user._id)) {
      throw new Forbidden('only_creator_can_permanently_delete');
    }

    // NOTE: Actual S3 object cleanup would be an async job.
    // For now we hard-delete the DB records.

    // Collect all descendant folder IDs
    const allFolderIds = await DriveAccessService.collectDescendantFolderIds({
      projectId: project._id,
      rootFolderId: folder._id,
      includeRoot: true,
    });

    // Remove files in those folders permanently
    // (Just a note: we keep the DB records removed; S3 cleanup is a separate concern)
    // For now, hard delete the DB records:
    const DriveFile = (await import('zillit-libs/mongo-models-v2/DriveFile')).default;
    const DriveFolder = (await import('zillit-libs/mongo-models-v2/DriveFolder')).default;
    const DriveFolderAccess = (await import('zillit-libs/mongo-models-v2/DriveFolderAccess')).default;
    const DriveFileAccess = (await import('zillit-libs/mongo-models-v2/DriveFileAccess')).default;
    const DriveFileVersion = (await import('zillit-libs/mongo-models-v2/DriveFileVersion')).default;
    const DriveComment = (await import('zillit-libs/mongo-models-v2/DriveComment')).default;
    const DriveFavorite = (await import('zillit-libs/mongo-models-v2/DriveFavorite')).default;
    const DriveItemTag = (await import('zillit-libs/mongo-models-v2/DriveItemTag')).default;

    // Get file IDs before deleting (needed for access/version/comment cleanup)
    const filesToDelete = await DriveFile.find({
      project_id: project._id,
      folder_id: { $in: allFolderIds },
    }).select('_id').lean();
    const fileIds = filesToDelete.map((f) => f._id);

    await Promise.all([
      // Core records
      DriveFile.deleteMany({ project_id: project._id, folder_id: { $in: allFolderIds } }),
      DriveFolder.deleteMany({ project_id: project._id, _id: { $in: allFolderIds } }),
      // Access records
      DriveFolderAccess.deleteMany({ project_id: project._id, folder_id: { $in: allFolderIds } }),
      ...(fileIds.length > 0 ? [
        DriveFileAccess.deleteMany({ project_id: project._id, file_id: { $in: fileIds } }),
        DriveFileVersion.deleteMany({ project_id: project._id, file_id: { $in: fileIds } }),
        DriveComment.deleteMany({ project_id: project._id, file_id: { $in: fileIds } }),
      ] : []),
      // Favorites + tags for both files and folders
      DriveFavorite.deleteMany({ project_id: project._id, item_id: { $in: [...allFolderIds, ...fileIds] } }),
      DriveItemTag.deleteMany({ project_id: project._id, item_id: { $in: [...allFolderIds, ...fileIds] } }),
    ]);

    // TODO: Delete S3 objects (files + version snapshots) via async job

    return { message: 'Folder permanently deleted' };
  }

  // Permanent delete a file
  const file = await DriveFileRepository.getFile({
    filters: { _id: itemId, project_id: project._id, deleted_on: { $gt: 0 } },
  });

  if (!file) {
    throw new BadRequest('file_not_found_in_trash');
  }

  // Only the file creator can permanently delete
  if (String(file.created_by) !== String(user._id)) {
    throw new Forbidden('only_creator_can_permanently_delete');
  }

  const DriveFile = (await import('zillit-libs/mongo-models-v2/DriveFile')).default;
  const DriveFileAccess = (await import('zillit-libs/mongo-models-v2/DriveFileAccess')).default;
  const DriveFileVersion = (await import('zillit-libs/mongo-models-v2/DriveFileVersion')).default;
  const DriveComment = (await import('zillit-libs/mongo-models-v2/DriveComment')).default;
  const DriveFavorite = (await import('zillit-libs/mongo-models-v2/DriveFavorite')).default;
  const DriveItemTag = (await import('zillit-libs/mongo-models-v2/DriveItemTag')).default;

  await Promise.all([
    DriveFile.deleteOne({ _id: itemId, project_id: project._id }),
    DriveFileAccess.deleteMany({ file_id: itemId, project_id: project._id }),
    DriveFileVersion.deleteMany({ file_id: itemId, project_id: project._id }),
    DriveComment.deleteMany({ file_id: itemId, project_id: project._id }),
    DriveFavorite.deleteMany({ item_id: itemId, project_id: project._id }),
    DriveItemTag.deleteMany({ item_id: itemId, project_id: project._id }),
  ]);

  // TODO: Delete S3 objects (file + version snapshots) via async job

  return { message: 'File permanently deleted' };
};

// ───────────────────────────────────────────────────────────
//  Empty user's own trash
// ───────────────────────────────────────────────────────────

const emptyTrash = async ({ user, project }) => {
  const DriveFile = (await import('zillit-libs/mongo-models-v2/DriveFile')).default;
  const DriveFolder = (await import('zillit-libs/mongo-models-v2/DriveFolder')).default;
  const DriveFolderAccess = (await import('zillit-libs/mongo-models-v2/DriveFolderAccess')).default;
  const DriveFileAccess = (await import('zillit-libs/mongo-models-v2/DriveFileAccess')).default;
  const DriveFileVersion = (await import('zillit-libs/mongo-models-v2/DriveFileVersion')).default;
  const DriveComment = (await import('zillit-libs/mongo-models-v2/DriveComment')).default;
  const DriveFavorite = (await import('zillit-libs/mongo-models-v2/DriveFavorite')).default;
  const DriveItemTag = (await import('zillit-libs/mongo-models-v2/DriveItemTag')).default;

  // Get IDs before deleting (needed for related data cleanup)
  const deletedFiles = await DriveFile.find({
    project_id: project._id, created_by: user._id, deleted_on: { $gt: 0 },
  }).select('_id').lean();
  const deletedFileIds = deletedFiles.map((f) => f._id);

  const deletedFolders = await DriveFolderRepository.getFolders({
    filters: { project_id: project._id, created_by: user._id, deleted_on: { $gt: 0 } },
  });
  const deletedFolderIds = deletedFolders.map((f) => f._id);

  const allItemIds = [...deletedFileIds, ...deletedFolderIds];

  await Promise.all([
    // Core records
    DriveFile.deleteMany({ project_id: project._id, created_by: user._id, deleted_on: { $gt: 0 } }),
    DriveFolder.deleteMany({ project_id: project._id, created_by: user._id, deleted_on: { $gt: 0 } }),
    // Access records (delete ALL access, not just soft-deleted ones)
    ...(deletedFolderIds.length > 0
      ? [DriveFolderAccess.deleteMany({ project_id: project._id, folder_id: { $in: deletedFolderIds } })]
      : []),
    ...(deletedFileIds.length > 0 ? [
      DriveFileAccess.deleteMany({ project_id: project._id, file_id: { $in: deletedFileIds } }),
      DriveFileVersion.deleteMany({ project_id: project._id, file_id: { $in: deletedFileIds } }),
      DriveComment.deleteMany({ project_id: project._id, file_id: { $in: deletedFileIds } }),
    ] : []),
    // Favorites + tags for all deleted items
    ...(allItemIds.length > 0 ? [
      DriveFavorite.deleteMany({ project_id: project._id, item_id: { $in: allItemIds } }),
      DriveItemTag.deleteMany({ project_id: project._id, item_id: { $in: allItemIds } }),
    ] : []),
  ]);

  // TODO: Delete S3 objects via async job

  return { message: 'Trash emptied successfully' };
};

export default {
  listTrash,
  restoreItem,
  permanentDelete,
  emptyTrash,
};
