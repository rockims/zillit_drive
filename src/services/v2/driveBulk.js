import archiver from 'archiver';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import DriveFavorite from 'zillit-libs/mongo-models-v2/DriveFavorite';
import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFolderRepository from '../../repositories/v2/driveFolder.js';
import DriveAccessService from './driveAccess.js';
import DriveFileAccessService from './driveFileAccess.js';
import DriveActivityService from './driveActivity.js';
import BadRequest from 'zillit-libs/errors/BadRequest';
import socketClient from '../../config/socketClient.js';

const S3_DEFAULT_REGION = process.env.S3_REGION || process.env.AWS_REGION || 'ap-south-1';
const S3_BUCKET = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || 'zillit-drive';

const s3ClientCache = {};
const getS3Client = (region) => {
  const r = region || S3_DEFAULT_REGION;
  if (!s3ClientCache[r]) {
    s3ClientCache[r] = new S3Client({
      region: r,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3ClientCache[r];
};

/**
 * DriveBulkService — bulk operations: delete, move, download URLs.
 */

// ── Bulk Delete ──
const bulkDelete = async ({ user, project, device, body }) => {
  const { items } = body;

  if (!Array.isArray(items) || items.length === 0) {
    throw new BadRequest('items_required');
  }

  if (items.length > 100) {
    throw new BadRequest('max_100_items_per_bulk_operation');
  }

  const deleteTimestamp = Date.now();
  const deleteData = {
    deleted_on: deleteTimestamp,
    updated_by: user._id,
    updated_on: deleteTimestamp,
  };

  const results = { deleted: 0, failed: 0, errors: [] };

  for (const item of items) {
    try {
      if (item.type === 'folder') {
        const folder = await DriveFolderRepository.getFolder({
          filters: { _id: item.id, project_id: project._id, deleted_on: 0 },
        });
        if (!folder) {
          results.failed++;
          results.errors.push({ id: item.id, error: 'not_found' });
          continue;
        }

        // Only owner/admin can delete folders
        await DriveAccessService.assertFolderAccess({
          user, project, folder, minRole: 'owner',
        });

        const folderIds = await DriveAccessService.collectDescendantFolderIds({
          projectId: project._id, rootFolderId: folder._id, includeRoot: true,
        });

        await Promise.all([
          DriveFileRepository.updateFiles({
            filters: { project_id: project._id, folder_id: { $in: folderIds }, deleted_on: 0 },
            data: deleteData,
          }),
          DriveFolderRepository.updateFolders({
            filters: { project_id: project._id, _id: { $in: folderIds }, deleted_on: 0 },
            data: deleteData,
          }),
          DriveAccessService.softDeleteFolderAccess({ projectId: project._id, folderIds, data: deleteData }),
        ]);

        results.deleted++;
      } else {
        const file = await DriveFileRepository.getFile({
          filters: { _id: item.id, project_id: project._id, deleted_on: 0 },
        });
        if (!file) {
          results.failed++;
          results.errors.push({ id: item.id, error: 'not_found' });
          continue;
        }

        // Enforce file-level delete permission (only owner/admin can delete)
        await DriveFileAccessService.assertFileAccess({ user, project, file, permission: 'delete' });

        await DriveFileRepository.deleteFile({
          filters: { _id: item.id, project_id: project._id, deleted_on: 0 },
          data: deleteData,
        });
        results.deleted++;
      }
    } catch (err) {
      results.failed++;
      results.errors.push({ id: item.id, error: err.message });
    }
  }

  socketClient('__admin_events__', {
    event: 'drive:bulk:deleted',
    room: `${project._id.toString()}_room`,
    data: { project_id: project._id, results },
  });

  // Activity log for each successfully deleted item (fire-and-forget)
  for (const item of items) {
    if (!results.errors.find((e) => e.id === item.id)) {
      DriveActivityService.log({
        projectId: project._id, userId: user._id,
        action: item.type === 'folder' ? 'folder_deleted' : 'file_deleted',
        itemId: item.id, itemType: item.type,
        details: { bulk: true },
      });
    }
  }

  return results;
};

// ── Bulk Move ──
const bulkMove = async ({ user, project, device, body }) => {
  const { items, target_folder_id } = body;

  if (!Array.isArray(items) || items.length === 0) {
    throw new BadRequest('items_required');
  }

  if (items.length > 100) {
    throw new BadRequest('max_100_items_per_bulk_operation');
  }

  // Validate target folder if provided
  let targetFolder = null;
  if (target_folder_id) {
    targetFolder = await DriveFolderRepository.getFolder({
      filters: { _id: target_folder_id, project_id: project._id, deleted_on: 0 },
    });
    if (!targetFolder) {
      throw new BadRequest('target_folder_not_found');
    }
  }

  const now = Date.now();
  const results = { moved: 0, failed: 0, errors: [] };

  for (const item of items) {
    try {
      if (item.type === 'folder') {
        const folder = await DriveFolderRepository.getFolder({
          filters: { _id: item.id, project_id: project._id, deleted_on: 0 },
        });
        if (!folder) {
          results.failed++;
          results.errors.push({ id: item.id, error: 'not_found' });
          continue;
        }

        // Check editor access before moving
        await DriveAccessService.assertFolderAccess({
          user, project, folder, minRole: 'editor',
        });

        await DriveFolderRepository.updateFolder({
          filters: { _id: item.id, project_id: project._id, deleted_on: 0 },
          data: {
            parent_folder_id: target_folder_id || null,
            updated_by: user._id,
            updated_on: now,
          },
        });
      } else {
        const file = await DriveFileRepository.getFile({
          filters: { _id: item.id, project_id: project._id, deleted_on: 0 },
        });
        if (!file) {
          results.failed++;
          results.errors.push({ id: item.id, error: 'not_found' });
          continue;
        }

        // Enforce file-level edit permission before moving
        await DriveFileAccessService.assertFileAccess({ user, project, file, permission: 'edit' });

        await DriveFileRepository.updateFile({
          filters: { _id: item.id, project_id: project._id, deleted_on: 0 },
          data: {
            folder_id: target_folder_id || null,
            updated_by: user._id,
            updated_on: now,
          },
        });

        // ZL-18478: snapshot the target folder's ACL onto the moved file so
        // folder members appear in the file's "shared with" list. Wrapped in
        // try/catch — the move already succeeded, never let an ACL snapshot
        // hiccup downgrade the result.moved counter. Same helper as moveFile.
        if (targetFolder) {
          try {
            await DriveFileAccessService.snapshotFolderAccessToFile({
              project,
              file: { ...file._doc || file, folder_id: target_folder_id },
              folder: targetFolder,
              actorId: user._id,
            });
          } catch (err) {
            console.error('[bulkMove] snapshotFolderAccessToFile failed:', err.message);
          }
        }
      }
      results.moved++;
    } catch (err) {
      results.failed++;
      results.errors.push({ id: item.id, error: err.message });
    }
  }

  socketClient('__admin_events__', {
    event: 'drive:bulk:moved',
    room: `${project._id.toString()}_room`,
    data: { project_id: project._id, results },
  });

  // Activity log for each successfully moved item (fire-and-forget)
  for (const item of items) {
    if (!results.errors.find((e) => e.id === item.id)) {
      DriveActivityService.log({
        projectId: project._id, userId: user._id,
        action: item.type === 'folder' ? 'folder_moved' : 'file_moved',
        itemId: item.id, itemType: item.type,
        details: { target_folder_id: target_folder_id || null, bulk: true },
      });
    }
  }

  return results;
};

// ── Bulk Download URLs ──
const bulkDownloadUrls = async ({ user, project, body }) => {
  const { file_ids } = body;

  if (!Array.isArray(file_ids) || file_ids.length === 0) {
    throw new BadRequest('file_ids_required');
  }

  if (file_ids.length > 50) {
    throw new BadRequest('max_50_files_per_download');
  }

  const urls = [];

  for (const fileId of file_ids) {
    const file = await DriveFileRepository.getFile({
      filters: { _id: fileId, project_id: project._id, deleted_on: 0 },
    });

    if (!file) continue;

    // Enforce file-level download permission
    try {
      await DriveFileAccessService.assertFileAccess({ user, project, file, permission: 'download' });
    } catch {
      continue; // Skip files user cannot download
    }

    const s3Key = file.file_path || file.attachments?.[0]?.media || file.attachments?.[0]?.file_path;
    if (!s3Key) continue;

    const attachment = file.attachments?.[0] || {};
    const bucket = attachment.bucket || S3_BUCKET;
    const region = attachment.region || S3_DEFAULT_REGION;
    const s3ForRegion = getS3Client(region);

    const cmd = new GetObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(file.file_name || 'download')}"`,
    });

    const presignedUrl = await getSignedUrl(s3ForRegion, cmd, { expiresIn: 3600 });

    urls.push({
      file_id: fileId,
      file_name: file.file_name,
      url: presignedUrl,
      file_size_bytes: file.file_size_bytes || 0,
    });
  }

  return { urls };
};

// ── Bulk Download as ZIP (streams directly to response) ──
const bulkDownloadZip = async ({ user, project, body, res }) => {
  const { file_ids } = body;

  if (!Array.isArray(file_ids) || file_ids.length === 0) {
    throw new BadRequest('file_ids_required');
  }

  if (file_ids.length > 50) {
    throw new BadRequest('max_50_files_per_download');
  }

  // Collect file metadata
  const files = [];
  for (const fileId of file_ids) {
    const file = await DriveFileRepository.getFile({
      filters: { _id: fileId, project_id: project._id, deleted_on: 0 },
    });
    if (!file) continue;

    // Enforce file-level download permission
    try {
      await DriveFileAccessService.assertFileAccess({ user, project, file, permission: 'download' });
    } catch {
      continue; // Skip files user cannot download
    }

    const s3Key = file.file_path || file.attachments?.[0]?.media || file.attachments?.[0]?.file_path;
    if (!s3Key) continue;

    const attachment = file.attachments?.[0] || {};
    files.push({
      file_name: file.file_name || 'download',
      s3Key,
      bucket: attachment.bucket || S3_BUCKET,
      region: attachment.region || S3_DEFAULT_REGION,
    });
  }

  if (files.length === 0) {
    throw new BadRequest('no_downloadable_files_found');
  }

  // Set response headers for ZIP streaming
  const zipName = `drive-download-${Date.now()}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  // Create archiver instance
  const archive = archiver('zip', { zlib: { level: 5 } });

  archive.on('error', (err) => {
    console.error('[bulk_zip_error]:', err);
    if (!res.headersSent) {
      res.status(500).json({ status: false, message: 'zip_generation_failed' });
    }
  });

  // Pipe archive to response
  archive.pipe(res);

  // Track file names to avoid duplicates in ZIP
  const usedNames = {};
  const getUniqueName = (name) => {
    if (!usedNames[name]) {
      usedNames[name] = 1;
      return name;
    }
    usedNames[name]++;
    const ext = name.includes('.') ? `.${name.split('.').pop()}` : '';
    const base = ext ? name.slice(0, -ext.length) : name;
    return `${base} (${usedNames[name] - 1})${ext}`;
  };

  // Stream each file from S3 into the archive
  for (const file of files) {
    try {
      const s3ForRegion = getS3Client(file.region);
      const cmd = new GetObjectCommand({
        Bucket: file.bucket,
        Key: file.s3Key,
      });
      const s3Resp = await s3ForRegion.send(cmd);
      const uniqueName = getUniqueName(file.file_name);
      archive.append(s3Resp.Body, { name: uniqueName });
    } catch (err) {
      console.error(`[bulk_zip] Failed to fetch ${file.file_name}:`, err.message);
      // Skip failed files, continue with rest
    }
  }

  // Finalize the archive
  await archive.finalize();
};

// ── Bulk Favorite ──
// Add/remove/toggle favorite status on many files+folders in one call.
// Mirrors the per-item toggleFavorite semantics but resolves existence
// + existing favorites in batched queries so 100 items = 3 round-trips,
// not 300.
const bulkFavorite = async ({ user, project, body }) => {
  const { items, mode = 'toggle' } = body || {};

  if (!Array.isArray(items) || items.length === 0) {
    throw new BadRequest('items_required');
  }
  if (items.length > 100) {
    throw new BadRequest('max_100_items_per_bulk_operation');
  }
  if (!['add', 'remove', 'toggle'].includes(mode)) {
    throw new BadRequest('invalid_mode');
  }

  // Validate each item shape up front so a single bad row fails the
  // batch instead of silently dropping items.
  for (const item of items) {
    if (!item || !item.id || !['file', 'folder'].includes(item.type)) {
      throw new BadRequest('invalid_item_shape');
    }
  }

  const fileIds = items.filter((i) => i.type === 'file').map((i) => i.id);
  const folderIds = items.filter((i) => i.type === 'folder').map((i) => i.id);
  const allIds = items.map((i) => i.id);

  const [existingFiles, existingFolders, existingFavs] = await Promise.all([
    fileIds.length
      ? DriveFileRepository.getFiles({
        filters: { _id: { $in: fileIds }, project_id: project._id, deleted_on: 0 },
      })
      : Promise.resolve([]),
    folderIds.length
      ? DriveFolderRepository.getFolders({
        filters: { _id: { $in: folderIds }, project_id: project._id, deleted_on: 0 },
      })
      : Promise.resolve([]),
    DriveFavorite.find({
      project_id: project._id,
      user_id: user._id,
      item_id: { $in: allIds },
    }),
  ]);

  const validFileIds = new Set(existingFiles.map((f) => String(f._id)));
  const validFolderIds = new Set(existingFolders.map((f) => String(f._id)));
  const alreadyFav = new Set(existingFavs.map((f) => String(f.item_id)));

  const toCreate = [];
  const toDelete = [];
  const results = {
    added: 0, removed: 0, unchanged: 0, failed: 0, errors: [], items: [],
  };

  for (const item of items) {
    const idStr = String(item.id);
    const exists = item.type === 'file' ? validFileIds.has(idStr) : validFolderIds.has(idStr);
    if (!exists) {
      results.failed += 1;
      results.errors.push({ id: item.id, error: 'not_found' });
      results.items.push({
        id: item.id, type: item.type, favorited: alreadyFav.has(idStr), error: 'not_found',
      });
      continue;
    }
    const isFav = alreadyFav.has(idStr);
    // Resolve final action given mode + current state.
    let action = 'noop';
    if (mode === 'add') action = isFav ? 'noop' : 'add';
    else if (mode === 'remove') action = isFav ? 'remove' : 'noop';
    else action = isFav ? 'remove' : 'add';

    if (action === 'add') {
      toCreate.push({
        project_id: project._id,
        user_id: user._id,
        item_id: item.id,
        item_type: item.type,
      });
      results.added += 1;
      results.items.push({ id: item.id, type: item.type, favorited: true });
    } else if (action === 'remove') {
      toDelete.push(item.id);
      results.removed += 1;
      results.items.push({ id: item.id, type: item.type, favorited: false });
    } else {
      results.unchanged += 1;
      results.items.push({ id: item.id, type: item.type, favorited: isFav });
    }
  }

  await Promise.all([
    toCreate.length
      ? DriveFavorite.insertMany(toCreate, { ordered: false })
      : Promise.resolve(),
    toDelete.length
      ? DriveFavorite.deleteMany({
        project_id: project._id,
        user_id: user._id,
        item_id: { $in: toDelete },
      })
      : Promise.resolve(),
  ]);

  return results;
};

// ── Bulk Share ──
// Apply the same access list to many files+folders. Files take boolean
// permissions (can_view/can_edit/can_download); folders take a role
// (viewer/editor/owner). Caller may pass `role` on each entry; if
// absent for a folder, we derive role from can_edit (edit→editor,
// otherwise viewer). Owner is never auto-derived to avoid silent
// privilege escalation.
//
// Per-item failures don't abort the batch — they're recorded in
// `results.errors` so the FE can surface partial success (matches the
// bulkDelete/bulkMove contract).
const bulkShare = async ({ user, project, device, body }) => {
  const { items, entries, replace_existing = false } = body || {};

  if (!Array.isArray(items) || items.length === 0) {
    throw new BadRequest('items_required');
  }
  if (items.length > 100) {
    throw new BadRequest('max_100_items_per_bulk_operation');
  }
  if (!Array.isArray(entries)) {
    throw new BadRequest('entries_required');
  }
  if (entries.length > 50) {
    throw new BadRequest('max_50_users_per_bulk_share');
  }

  for (const item of items) {
    if (!item || !item.id || !['file', 'folder'].includes(item.type)) {
      throw new BadRequest('invalid_item_shape');
    }
  }
  for (const e of entries) {
    if (!e || !e.user_id) throw new BadRequest('invalid_entry_shape');
  }

  // Pre-compute both shapes so each per-item branch just calls into
  // setFileAccessList / setFolderAccessList.
  const fileEntries = entries.map((e) => ({
    user_id: e.user_id,
    can_view: e.can_view !== false,
    can_edit: !!e.can_edit,
    can_download: e.can_download !== false,
  }));
  const folderEntries = entries.map((e) => {
    const role = ['viewer', 'editor', 'owner'].includes(e.role)
      ? e.role
      : (e.can_edit ? 'editor' : 'viewer');
    return { user_id: e.user_id, role };
  });

  const results = {
    shared: 0, failed: 0, errors: [], items: [],
  };

  for (const item of items) {
    try {
      if (item.type === 'file') {
        await DriveFileAccessService.setFileAccessList({
          user, project, fileId: item.id, entries: fileEntries,
        });
      } else {
        const folder = await DriveFolderRepository.getFolder({
          filters: { _id: item.id, project_id: project._id, deleted_on: 0 },
        });
        if (!folder) {
          results.failed += 1;
          results.errors.push({ id: item.id, error: 'not_found' });
          results.items.push({ id: item.id, type: item.type, shared: false, error: 'not_found' });
          continue;
        }
        await DriveAccessService.setFolderAccessList({
          user,
          project,
          folder,
          entries: folderEntries,
          replaceExisting: replace_existing === true,
        });
      }
      results.shared += 1;
      results.items.push({ id: item.id, type: item.type, shared: true });
    } catch (err) {
      results.failed += 1;
      results.errors.push({ id: item.id, error: err.message });
      results.items.push({
        id: item.id, type: item.type, shared: false, error: err.message,
      });
    }
  }

  // Fire-and-forget activity entries for the successful items so the
  // project activity feed reflects "shared with N users" per file/folder.
  for (const r of results.items) {
    if (!r.shared) continue;
    DriveActivityService.log({
      projectId: project._id,
      userId: user._id,
      action: r.type === 'folder' ? 'folder_shared' : 'file_shared',
      itemId: r.id,
      itemType: r.type,
      details: { bulk: true, user_count: entries.length },
    });
  }

  socketClient('__admin_events__', {
    event: 'drive:bulk:shared',
    room: `${project._id.toString()}_room`,
    data: { project_id: project._id, results },
  });

  return results;
};

export default {
  bulkDelete,
  bulkMove,
  bulkDownloadUrls,
  bulkDownloadZip,
  bulkFavorite,
  bulkShare,
};
