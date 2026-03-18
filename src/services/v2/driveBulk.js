import archiver from 'archiver';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFolderRepository from '../../repositories/v2/driveFolder.js';
import DriveAccessService from './driveAccess.js';
import DriveFileAccessService from './driveFileAccess.js';
import DriveActivityService from './driveActivity.js';
import BadRequest from 'zillit-libs/errors/BadRequest';
import socketClient from '../../config/socketClient.js';

const S3_DEFAULT_REGION = process.env.AWS_REGION || 'ap-south-1';
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

        // Check access
        await DriveAccessService.assertFolderAccess({
          user, project, folder, minRole: 'editor',
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

        // Enforce file-level edit permission before deleting
        await DriveFileAccessService.assertFileAccess({ user, project, file, permission: 'edit' });

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
  if (target_folder_id) {
    const targetFolder = await DriveFolderRepository.getFolder({
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

export default {
  bulkDelete,
  bulkMove,
  bulkDownloadUrls,
  bulkDownloadZip,
};
