import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import BadRequest from 'zillit-libs/errors/BadRequest';
import Forbidden from 'zillit-libs/errors/Forbidden';
import NotificationService from 'zillit-libs/services-v2/notification';
import { rights } from 'zillit-libs/services-v2/permissions';

import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFileAccessRepository from '../../repositories/v2/driveFileAccess.js';
import DriveFolderRepository from '../../repositories/v2/driveFolder.js';
import DriveAccessService from './driveAccess.js';
import DriveFileAccessService from './driveFileAccess.js';
import DriveActivityService from './driveActivity.js';
import DriveNotificationReceivers from './driveNotificationReceivers.js';
import socketClient, { buildUserRooms } from '../../config/socketClient.js';

// Field sanitization — prevents injection of protected fields
const FILE_ALLOWED_FIELDS = ['file_name', 'folder_id', 'file_path', 'description', 'file_type', 'file_extension', 'file_size', 'file_size_bytes', 'mime_type', 'attachments'];
const pickAllowedFields = (body, allowedFields) => {
  const result = {};
  allowedFields.forEach((field) => {
    if (body[field] !== undefined) result[field] = body[field];
  });
  return result;
};

/* ───────────── S3 Client (for presigned GET URLs) ───────────── */

const S3_DEFAULT_REGION = process.env.S3_REGION || process.env.AWS_REGION || 'ap-south-1';
const S3_BUCKET = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || 'zillit-drive';
const STREAM_URL_EXPIRY_SECONDS = 3600; // 1 hour

// Cache S3 clients per region so we don't recreate on every request
const s3ClientCache = {};

const getS3Client = (region) => {
  const resolvedRegion = region || S3_DEFAULT_REGION;
  if (!s3ClientCache[resolvedRegion]) {
    s3ClientCache[resolvedRegion] = new S3Client({
      region: resolvedRegion,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3ClientCache[resolvedRegion];
};

const {
  sections, tools, units,
} = NotificationService.NotificationConstants;

// Drive-specific constants — not yet in zillit-libs NotificationConstants
const DRIVE_TOOL = 'drive_label';
const DRIVE_UNIT_FILE = 'drive_file_label';
const DRIVE_UNIT_FOLDER = 'drive_folder_label';

const toIdString = (value) => (value ? value.toString() : null);
const idsEqual = (valueA, valueB) => toIdString(valueA) === toIdString(valueB);

const parsePagination = (query = {}) => {
  const rawLimit = Number(query.limit);
  const rawOffset = Number(query.offset);

  const hasLimit = Number.isInteger(rawLimit) && rawLimit > 0;
  const hasOffset = Number.isInteger(rawOffset) && rawOffset >= 0;

  const limit = hasLimit ? Math.min(rawLimit, 200) : 50;
  const offset = hasOffset ? rawOffset : 0;

  return {
    enabled: Boolean(query.limit || query.offset || query.paginate === 'true'),
    limit,
    offset,
  };
};

const escapeRegex = (value = '') =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseListingQuery = (query = {}) => {
  const sortByInput = String(query.sort_by || '').toLowerCase();
  const sortOrderInput = String(query.sort_order || '').toLowerCase();
  const groupByInput = String(query.group_by || 'none').toLowerCase();
  const viewInput = String(query.view || 'all').toLowerCase();
  const quickFilterInput = String(query.quick_filter || 'none').toLowerCase();

  const sortBy = ['name', 'date', 'size', 'uploaded_by', 'type'].includes(sortByInput)
    ? sortByInput
    : 'date';
  const sortOrder = sortOrderInput === 'asc' ? 'asc' : 'desc';
  const groupBy = ['none', 'type', 'uploaded_by', 'extension'].includes(groupByInput)
    ? groupByInput
    : 'none';
  const view = ['all', 'files', 'folders'].includes(viewInput) ? viewInput : 'all';
  const quickFilter = ['none', 'mine', 'shared', 'last_7_days', 'large_files'].includes(quickFilterInput)
    ? quickFilterInput
    : 'none';

  const rawSearch = String(query.search || '').trim();
  const searchRegex = rawSearch ? new RegExp(escapeRegex(rawSearch), 'i') : null;

  const largeFileThresholdBytes = Number(query.large_file_threshold_bytes) > 0
    ? Number(query.large_file_threshold_bytes)
    : 100 * 1024 * 1024;

  return {
    sortBy,
    sortOrder,
    groupBy,
    view,
    quickFilter,
    searchRegex,
    includeMeta: query.include_meta === 'true',
    largeFileThresholdBytes,
  };
};

const buildFileSort = ({ sortBy, sortOrder }) => {
  const direction = sortOrder === 'asc' ? 1 : -1;

  if (sortBy === 'name') {
    return { file_name: direction, _id: 1 };
  }

  if (sortBy === 'size') {
    return { file_size_bytes: direction, _id: 1 };
  }

  if (sortBy === 'uploaded_by') {
    return { uploaded_by: direction, _id: 1 };
  }

  if (sortBy === 'type') {
    return { file_type: direction, _id: 1 };
  }

  return { updated_on: direction, created_on: direction, _id: 1 };
};

const buildFileGrouping = ({ items, groupBy }) => {
  if (groupBy === 'none') {
    return [];
  }

  const buckets = new Map();
  items.forEach((item) => {
    let bucket = 'Unknown';

    if (groupBy === 'type') {
      bucket = item?.file_type || 'Unknown';
    } else if (groupBy === 'uploaded_by') {
      bucket = toIdString(item?.uploaded_by) || 'Unknown';
    } else if (groupBy === 'extension') {
      bucket = item?.file_extension || 'No Extension';
    }

    buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
  });

  return Array.from(buckets.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
};

const _viewingRightsUsers = async (project) => {
  const usersWithRights = await rights.toolUsersRights({
    projectId: project._id,
    identifier: 'drive_tool',
  });
  return usersWithRights.filter((item) => item.view_access).map((item) => item.user_id.toString());
};

const _getFolderById = ({ project, folderId }) => DriveFolderRepository.getFolder({
  filters: {
    _id: folderId,
    project_id: project._id,
    deleted_on: 0,
  },
});

const _assertRootFileReadAccess = async ({ user, file, project }) => {
  // File creator always has access
  if (idsEqual(file.created_by, user._id)) {
    return;
  }

  // Check if user has explicit file-level access (e.g. file was shared with them)
  if (project) {
    const fileAccess = await DriveFileAccessRepository.getAccess({
      filters: {
        project_id: project._id,
        file_id: file._id,
        user_id: user._id,
        deleted_on: 0,
      },
    });
    if (fileAccess && fileAccess.can_view) {
      return;
    }
  }

  throw new Forbidden('insufficient_permissions');
};

const _assertRootFileWriteAccess = async ({ user, file, project }) => {
  // File creator always has write access
  if (idsEqual(file.created_by, user._id)) {
    return;
  }

  // Check if user has explicit file-level edit access
  if (project) {
    const fileAccess = await DriveFileAccessRepository.getAccess({
      filters: {
        project_id: project._id,
        file_id: file._id,
        user_id: user._id,
        deleted_on: 0,
      },
    });
    if (fileAccess && fileAccess.can_edit) {
      return;
    }
  }

  throw new Forbidden('insufficient_permissions');
};

const createFile = async ({ user, project, device, body }) => {
  const normalizedFileName = body.file_name.trim().toLowerCase();

  let parentFolder = null;
  if (body.folder_id) {
    parentFolder = await _getFolderById({
      project,
      folderId: body.folder_id,
    });

    if (!parentFolder) {
      throw new BadRequest('folder_not_found');
    }

    await DriveAccessService.assertFolderAccess({
      user,
      project,
      folder: parentFolder,
      minRole: 'editor',
    });
  }

  // ZL-18867: Drive is a Private Drive — duplicate name check must be scoped to
  // the user's own files, not the entire project. Without created_by here,
  // User B couldn't upload a file named "report.pdf" if User A already had one.
  const duplicateFilters = {
    project_id: project._id,
    folder_id: body.folder_id || null,
    created_by: user._id,
    deleted_on: 0,
  };

  const existingFiles = await DriveFileRepository.getFiles({
    filters: duplicateFilters,
    sort: { _id: 1 },
  });

  const duplicateFile = existingFiles.find(
    (file) => file.file_name.trim().toLowerCase() === normalizedFileName
  );

  if (duplicateFile) {
    throw new BadRequest('duplicate_file_name');
  }

  const fileExtension = body.file_name.includes('.')
    ? body.file_name.split('.').pop().toLowerCase()
    : '';

  const sanitizedBody = pickAllowedFields(body, FILE_ALLOWED_FIELDS);

  // Handle attachment conversion: singular 'attachment' to plural 'attachments' array
  let attachments = [];
  if (body.attachments && Array.isArray(body.attachments)) {
    // If attachments array is provided, use it
    attachments = body.attachments;
  } else if (body.attachment && typeof body.attachment === 'object') {
    // If single attachment object is provided, convert to array
    attachments = [body.attachment];
  }

  const data = {
    ...sanitizedBody,
    project_id: project._id,
    created_by: user._id,
    updated_by: user._id,
    uploaded_by: user._id,
    file_extension: fileExtension,
    attachments: attachments,
  };

  // Remove the singular 'attachment' field to avoid confusion
  delete data.attachment;

  const file = await DriveFileRepository.createFile({ data });

  // Seed file-level access permissions
  try {
    await DriveFileAccessService.seedFileAccess({
      project,
      user,
      file,
      entries: [],
    });
  } catch (err) {
    console.error('[file_access_seed_failed]:', err.message);
  }

  const [receiverIds, notifLevels] = await Promise.all([
    DriveNotificationReceivers.getFileReceivers({
      project,
      actorId: user._id,
      fileId: file._id,
      folderId: file.folder_id,
    }),
    DriveNotificationReceivers.buildNotificationLevels({
      project,
      folderId: file.folder_id,
      itemId: file._id,
    }),
  ]);

  if (receiverIds.length > 0) {
    await NotificationService.notifyAll(
      {
        project,
        sender: user._id,
        receiver: receiverIds,
        section: sections.TOOLS,
        tool: DRIVE_TOOL,
        unit: DRIVE_UNIT_FILE,
        action: 'drive_file_uploaded',
        reference_id: notifLevels.reference_id,
        level_1: notifLevels.level_1,
        level_2: notifLevels.level_2,
        level_3: notifLevels.level_3,
        levels: notifLevels.levels,
        reference_data: {
          file_id: toIdString(file._id),
          file_name: file.file_name,
          folder_id: file.folder_id ? toIdString(file.folder_id) : null,
        },
        message: `New file "${file.file_name}" uploaded`,
      },
      { notify: true, save: true },
      socketClient,
    );
  }

  // ZL-18799: emit only to users with access (actor + ACL receivers) instead
  // of the project-wide room — broadcast was causing files to appear in
  // unrelated users' "Shared with Me". Socket server accepts room: [...]
  // and fans out to all listed user-rooms in a single emit (matches the
  // canonical pattern in zillit_project_managment::permission.js).
  socketClient('__admin_events__', {
    event: 'drive:file:added',
    room: buildUserRooms([user._id, ...receiverIds]),
    except: device._id,
    data: {
      project_id: project._id,
      device_id: device._id,
      folder_id: file.folder_id ? toIdString(file.folder_id) : null,
      file,
    },
  });

  // Activity log (fire-and-forget)
  DriveActivityService.log({
    projectId: project._id, userId: user._id, action: 'file_created',
    itemId: file._id, itemType: 'file', itemName: file.file_name,
  });

  return file;
};

const getFiles = async ({ user, project, query }) => {
  const listingQuery = parseListingQuery(query);
  const pagination = parsePagination(query);

  if (listingQuery.view === 'folders') {
    if (!pagination.enabled && !listingQuery.includeMeta && listingQuery.groupBy === 'none') {
      return [];
    }

    return {
      items: [],
      pagination: {
        total: 0,
        limit: pagination.limit,
        offset: pagination.offset,
        has_more: false,
      },
      grouping: [],
    };
  }

  const filters = {
    project_id: project._id,
    deleted_on: 0,
  };

  if (query.folder_id) {
    const folder = await _getFolderById({
      project,
      folderId: query.folder_id,
    });

    if (!folder) {
      throw new BadRequest('folder_not_found');
    }

    filters.folder_id = query.folder_id;

    // Check if user has folder-level access
    let hasFolderAccess = false;
    try {
      await DriveAccessService.assertFolderAccess({
        user,
        project,
        folder,
        minRole: 'viewer',
      });
      hasFolderAccess = true;
    } catch {
      hasFolderAccess = false;
    }

    if (!hasFolderAccess) {
      // User doesn't have folder access — only show files they have explicit file-level access to
      const accessibleFileIds = await DriveFileAccessRepository.distinctFileIds({
        filters: {
          project_id: project._id,
          user_id: user._id,
          can_view: true,
          deleted_on: 0,
        },
      });

      if (accessibleFileIds.length === 0) {
        // No accessible files in this folder at all
        throw new Forbidden('insufficient_permissions');
      }

      filters.$or = [
        { created_by: user._id },
        { _id: { $in: accessibleFileIds } },
      ];
    }
  } else if (query.folder_id === null || query.root === 'true') {
    filters.folder_id = null;
    // Show root files the user created OR has explicit access to
    const accessibleFileIds = await DriveFileAccessRepository.distinctFileIds({
      filters: {
        project_id: project._id,
        user_id: user._id,
        can_view: true,
        deleted_on: 0,
      },
    });
    filters.$or = [
      { created_by: user._id },
      ...(accessibleFileIds.length > 0 ? [{ _id: { $in: accessibleFileIds } }] : []),
    ];
  } else {
    const accessibleFolderIds = await DriveAccessService.listAccessibleFolderIds({
      user,
      project,
    });

    const accessibleFileIds = await DriveFileAccessRepository.distinctFileIds({
      filters: {
        project_id: project._id,
        user_id: user._id,
        can_view: true,
        deleted_on: 0,
      },
    });

    const folderFilter = accessibleFolderIds.length > 0
      ? [{ folder_id: { $in: accessibleFolderIds } }]
      : [];

    filters.$or = [
      ...folderFilter,
      { folder_id: null, created_by: user._id },
      ...(accessibleFileIds.length > 0 ? [{ _id: { $in: accessibleFileIds } }] : []),
    ];
  }

  if (query.file_type) {
    filters.file_type = query.file_type;
  }

  if (query.file_extension) {
    filters.file_extension = query.file_extension;
  }

  const andFilters = [filters];

  if (listingQuery.searchRegex) {
    andFilters.push({
      $or: [
        { file_name: listingQuery.searchRegex },
        { description: listingQuery.searchRegex },
      ],
    });
  }

  if (listingQuery.quickFilter === 'mine') {
    andFilters.push({ created_by: user._id });
  } else if (listingQuery.quickFilter === 'shared') {
    andFilters.push({ created_by: { $ne: user._id } });
  } else if (listingQuery.quickFilter === 'last_7_days') {
    andFilters.push({ created_on: { $gte: Date.now() - 7 * 24 * 60 * 60 * 1000 } });
  } else if (listingQuery.quickFilter === 'large_files') {
    andFilters.push({ file_size_bytes: { $gte: listingQuery.largeFileThresholdBytes } });
  }

  const finalFilters = andFilters.length === 1 ? andFilters[0] : { $and: andFilters };
  const shouldReturnMeta =
    pagination.enabled || listingQuery.includeMeta || listingQuery.groupBy !== 'none';

  const files = await DriveFileRepository.getFiles({
    filters: finalFilters,
    sort: buildFileSort(listingQuery),
    limit: pagination.enabled ? pagination.limit : null,
    skip: pagination.enabled ? pagination.offset : null,
  });

  // Resolve current user's permissions for each file
  const filesWithPermissions = await Promise.all(
    files.map(async (file) => {
      const fileObj = typeof file.toObject === 'function' ? file.toObject() : { ...file };
      const permissions = await DriveFileAccessService.resolveFilePermission({ user, project, file });
      fileObj._userPermissions = permissions || { can_view: false, can_edit: false, can_download: false, can_delete: false };
      // Fetch access entries once → derive both count and user id list
      // (web/mobile need _accessUserIds to render shared-user avatars instead of "Only You")
      // DriveFileAccessRepository.getAccesses populates user_id with the ProjectUser doc, so
      // e.user_id is a subdocument not an ObjectId — always extract `_id` first (same pattern
      // used by driveNotificationReceivers.js getFileReceivers) so the string is the hex id,
      // not the Node inspection form of the populated subdoc.
      try {
        const accessEntries = await DriveFileAccessRepository.getAccesses({
          filters: { file_id: file._id, project_id: project._id, deleted_on: 0 },
        });
        fileObj._accessCount = accessEntries.length;
        fileObj._accessUserIds = accessEntries
          .map((e) => (e.user_id?._id || e.user_id)?.toString())
          .filter(Boolean);
      } catch {
        fileObj._accessCount = 0;
        fileObj._accessUserIds = [];
      }
      return fileObj;
    }),
  );

  if (!shouldReturnMeta) {
    return filesWithPermissions;
  }

  const total = await DriveFileRepository.countFiles({ filters: finalFilters });

  return {
    items: filesWithPermissions,
    pagination: {
      total,
      limit: pagination.limit,
      offset: pagination.offset,
      has_more: pagination.offset + files.length < total,
    },
    grouping: buildFileGrouping({
      items: filesWithPermissions,
      groupBy: listingQuery.groupBy,
    }),
  };
};

const getFile = async ({ user, project, params }) => {
  const filters = {
    _id: params.fileId,
    project_id: project._id,
    deleted_on: 0,
  };

  const file = await DriveFileRepository.getFile({ filters });

  if (!file) {
    throw new BadRequest('file_not_found');
  }

  if (file.folder_id) {
    const folder = await _getFolderById({
      project,
      folderId: file.folder_id,
    });

    if (!folder) {
      throw new BadRequest('folder_not_found');
    }

    await DriveAccessService.assertFolderAccess({
      user,
      project,
      folder,
      minRole: 'viewer',
    });
  } else {
    await _assertRootFileReadAccess({ user, file, project });
  }

  // Enforce file-level permissions (falls back to folder role if no explicit record)
  await DriveFileAccessService.assertFileAccess({ user, project, file, permission: 'view' });

  // Attach current user's permissions
  const fileObj = typeof file.toObject === 'function' ? file.toObject() : { ...file };
  const permissions = await DriveFileAccessService.resolveFilePermission({ user, project, file });
  fileObj._userPermissions = permissions || { can_view: false, can_edit: false, can_download: false, can_delete: false };

  return fileObj;
};

const updateFile = async ({ user, project, device, params, body }) => {
  const fileId = params.fileId || body.file_id;

  if (!fileId) {
    throw new BadRequest('file_id_required');
  }

  const filters = {
    _id: fileId,
    project_id: project._id,
    deleted_on: 0,
  };

  const existingFile = await DriveFileRepository.getFile({ filters });
  if (!existingFile) {
    throw new BadRequest('file_not_found');
  }

  if (existingFile.folder_id) {
    const currentFolder = await _getFolderById({
      project,
      folderId: existingFile.folder_id,
    });

    if (!currentFolder) {
      throw new BadRequest('folder_not_found');
    }

    await DriveAccessService.assertFolderAccess({
      user,
      project,
      folder: currentFolder,
      minRole: 'editor',
    });
  } else {
    await _assertRootFileWriteAccess({ user, file: existingFile, project });
  }

  // Enforce file-level edit permission
  await DriveFileAccessService.assertFileAccess({ user, project, file: existingFile, permission: 'edit' });

  if (body.folder_id !== undefined && !idsEqual(body.folder_id, existingFile.folder_id)) {
    if (body.folder_id) {
      const targetFolder = await _getFolderById({
        project,
        folderId: body.folder_id,
      });

      if (!targetFolder) {
        throw new BadRequest('folder_not_found');
      }

      await DriveAccessService.assertFolderAccess({
        user,
        project,
        folder: targetFolder,
        minRole: 'editor',
      });
    }
  }

  if (body.file_name && body.file_name.trim().toLowerCase() !== existingFile.file_name.trim().toLowerCase()) {
    const normalizedFileName = body.file_name.trim().toLowerCase();
    const targetFolderId = body.folder_id !== undefined ? body.folder_id : existingFile.folder_id;

    // ZL-18867: scope duplicate check to the user's own files (Private Drive).
    const duplicateFilters = {
      project_id: project._id,
      folder_id: targetFolderId || null,
      created_by: user._id,
      deleted_on: 0,
      _id: { $ne: fileId },
    };

    const sameFolderFiles = await DriveFileRepository.getFiles({
      filters: duplicateFilters,
      sort: { _id: 1 },
    });

    const duplicateFile = sameFolderFiles.find(
      (file) => file.file_name.trim().toLowerCase() === normalizedFileName
    );

    if (duplicateFile) {
      throw new BadRequest('duplicate_file_name');
    }
  }

  const sanitizedBody = pickAllowedFields(body, FILE_ALLOWED_FIELDS);

  const updateData = {
    ...sanitizedBody,
    updated_by: user._id,
    updated_on: Date.now(),
  };

  if (body.file_name) {
    updateData.file_extension = body.file_name.includes('.')
      ? body.file_name.split('.').pop().toLowerCase()
      : '';
  }

  const updatedFile = await DriveFileRepository.updateFileDocument({ filters, data: updateData });

  if (!updatedFile) {
    throw new BadRequest('file_update_failed');
  }

  const [updateReceiverIds, updateNotifLevels] = await Promise.all([
    DriveNotificationReceivers.getFileReceivers({
      project,
      actorId: user._id,
      fileId: updatedFile._id,
      folderId: updatedFile.folder_id,
    }),
    DriveNotificationReceivers.buildNotificationLevels({
      project,
      folderId: updatedFile.folder_id,
      itemId: updatedFile._id,
    }),
  ]);

  if (updateReceiverIds.length > 0) {
    await NotificationService.notifyAll(
      {
        project,
        sender: user._id,
        receiver: updateReceiverIds,
        section: sections.TOOLS,
        tool: DRIVE_TOOL,
        unit: DRIVE_UNIT_FILE,
        action: 'drive_file_updated',
        reference_id: updateNotifLevels.reference_id,
        level_1: updateNotifLevels.level_1,
        level_2: updateNotifLevels.level_2,
        level_3: updateNotifLevels.level_3,
        levels: updateNotifLevels.levels,
        reference_data: {
          file_id: toIdString(updatedFile._id),
          file_name: updatedFile.file_name,
          folder_id: updatedFile.folder_id ? toIdString(updatedFile.folder_id) : null,
        },
        message: `File "${updatedFile.file_name}" updated`,
      },
      { notify: true, save: true },
      socketClient,
    );
  }

  socketClient('__admin_events__', {
    event: 'drive:file:updated',
    room: `${project._id.toString()}_room`,
    data: {
      project_id: project._id,
      device_id: device._id,
      folder_id: updatedFile.folder_id ? toIdString(updatedFile.folder_id) : null,
      file: updatedFile,
    },
  });

  // Activity log (fire-and-forget)
  DriveActivityService.log({
    projectId: project._id, userId: user._id, action: 'file_updated',
    itemId: updatedFile._id, itemType: 'file', itemName: updatedFile.file_name,
  });

  return updatedFile;
};

const deleteFile = async ({ user, project, device, params }) => {
  const filters = {
    _id: params.fileId,
    project_id: project._id,
    deleted_on: 0,
  };

  const file = await DriveFileRepository.getFile({ filters });

  if (!file) {
    throw new BadRequest('file_not_found');
  }

  // Check delete permission — only owner/admin/creator can delete
  await DriveFileAccessService.assertFileAccess({ user, project, file, permission: 'delete' });

  const deleteTimestamp = Date.now();
  const deleteData = {
    deleted_on: deleteTimestamp,
    updated_by: user._id,
    updated_on: deleteTimestamp,
  };

  await DriveFileRepository.deleteFile({ filters, data: deleteData });

  socketClient('__admin_events__', {
    event: 'drive:file:deleted',
    room: `${project._id.toString()}_room`,
    data: {
      project_id: project._id,
      device_id: device._id,
      folder_id: file.folder_id ? toIdString(file.folder_id) : null,
      file,
    },
  });

  // Activity log (fire-and-forget)
  DriveActivityService.log({
    projectId: project._id, userId: user._id, action: 'file_deleted',
    itemId: file._id, itemType: 'file', itemName: file.file_name,
  });

  return { message: 'File deleted successfully' };
};

const moveFile = async ({ user, project, device, params, body }) => {
  const { fileId } = params;
  const { target_folder_id } = body;

  const filters = {
    _id: fileId,
    project_id: project._id,
    deleted_on: 0,
  };

  const file = await DriveFileRepository.getFile({ filters });
  if (!file) {
    throw new BadRequest('file_not_found');
  }

  if (file.folder_id) {
    const sourceFolder = await _getFolderById({
      project,
      folderId: file.folder_id,
    });

    if (!sourceFolder) {
      throw new BadRequest('folder_not_found');
    }

    await DriveAccessService.assertFolderAccess({
      user,
      project,
      folder: sourceFolder,
      minRole: 'editor',
    });
  } else {
    await _assertRootFileWriteAccess({ user, file, project });
  }

  let targetFolder = null;
  if (target_folder_id) {
    targetFolder = await _getFolderById({
      project,
      folderId: target_folder_id,
    });

    if (!targetFolder) {
      throw new BadRequest('target_folder_not_found');
    }

    await DriveAccessService.assertFolderAccess({
      user,
      project,
      folder: targetFolder,
      minRole: 'editor',
    });
  }

  // ZL-18867: scope duplicate check to the user's own files (Private Drive).
  // A move is between folders the user owns, so user._id is the right scope.
  const duplicateFilters = {
    project_id: project._id,
    folder_id: target_folder_id || null,
    created_by: user._id,
    deleted_on: 0,
    _id: { $ne: fileId },
  };

  const sameFolderFiles = await DriveFileRepository.getFiles({
    filters: duplicateFilters,
    sort: { _id: 1 },
  });

  const duplicateFile = sameFolderFiles.find(
    (existingFile) => existingFile.file_name.trim().toLowerCase() === file.file_name.trim().toLowerCase()
  );

  if (duplicateFile) {
    throw new BadRequest('duplicate_file_name_in_target_folder');
  }

  const movedFile = await DriveFileRepository.updateFileDocument({
    filters,
    data: {
      folder_id: target_folder_id || null,
      updated_by: user._id,
      updated_on: Date.now(),
    },
  });

  // ZL-18478: snapshot the target folder's explicit ACL onto the moved file
  // so folder members appear in the file's "shared with" list (and stay there
  // even if the folder ACL changes later). Inheritance via runtime fallback
  // continues to work too — this just makes the access explicit. Wrapped in
  // try/catch — the move itself already succeeded above, never let an ACL
  // snapshot hiccup turn the API call into a failure.
  if (targetFolder) {
    try {
      await DriveFileAccessService.snapshotFolderAccessToFile({
        project,
        file: movedFile,
        folder: targetFolder,
        actorId: user._id,
      });
    } catch (err) {
      console.error('[moveFile] snapshotFolderAccessToFile failed:', err.message);
    }
  }

  const sourceFolderId = file.folder_id ? toIdString(file.folder_id) : null;
  const movedTargetFolderId = target_folder_id || null;
  const [moveReceiverIds, moveNotifLevels] = await Promise.all([
    DriveNotificationReceivers.getMoveReceivers({
      project,
      actorId: user._id,
      sourceFolderId,
      targetFolderId: movedTargetFolderId,
    }),
    DriveNotificationReceivers.buildNotificationLevels({
      project,
      folderId: movedFile.folder_id,
      itemId: movedFile._id,
    }),
  ]);

  if (moveReceiverIds.length > 0) {
    await NotificationService.notifyAll(
      {
        project,
        sender: user._id,
        receiver: moveReceiverIds,
        section: sections.TOOLS,
        tool: DRIVE_TOOL,
        unit: DRIVE_UNIT_FILE,
        action: 'drive_file_moved',
        reference_id: moveNotifLevels.reference_id,
        level_1: moveNotifLevels.level_1,
        level_2: moveNotifLevels.level_2,
        level_3: moveNotifLevels.level_3,
        levels: moveNotifLevels.levels,
        reference_data: {
          file_id: toIdString(movedFile._id),
          file_name: movedFile.file_name,
          folder_id: movedFile.folder_id ? toIdString(movedFile.folder_id) : null,
          target_folder_id: movedTargetFolderId,
        },
        message: `File "${movedFile.file_name}" moved`,
      },
      { notify: true, save: true },
      socketClient,
    );
  }

  socketClient('__admin_events__', {
    event: 'drive:file:moved',
    room: `${project._id.toString()}_room`,
    data: {
      project_id: project._id,
      device_id: device._id,
      folder_id: movedFile.folder_id ? toIdString(movedFile.folder_id) : null,
      file: movedFile,
    },
  });

  // Activity log (fire-and-forget)
  DriveActivityService.log({
    projectId: project._id, userId: user._id, action: 'file_moved',
    itemId: movedFile._id, itemType: 'file', itemName: movedFile.file_name,
    details: { target_folder_id: target_folder_id || null },
  });

  return movedFile;
};

const getFilesByType = async ({ user, project, query }) => {
  if (!query.file_type) {
    throw new BadRequest('file_type_required');
  }

  return getFiles({
    user,
    project,
    query,
  });
};

/* ───────────── File Stream / Download URL ───────────── */

const getFileStreamUrl = async ({ user, project, params, query = {} }) => {
  const file = await getFile({ user, project, params });

  // Enforce file-level download permission
  await DriveFileAccessService.assertFileAccess({ user, project, file, permission: 'download' });

  // Extract S3 key from file_path or attachments
  const s3Key = file.file_path
    || file.attachments?.[0]?.media
    || file.attachments?.[0]?.file_path;

  if (!s3Key) {
    throw new BadRequest('file_has_no_storage_path');
  }

  const attachment = file.attachments?.[0] || {};
  const bucket = attachment.bucket || S3_BUCKET;
  const region = attachment.region || S3_DEFAULT_REGION;

  // Use an S3 client configured for the correct region
  const s3ForRegion = getS3Client(region);

  // Resolve MIME type so the browser renders the file correctly
  const mimeType =
    file.mime_type ||
    file.content_type ||
    attachment.content_type ||
    '';

  const cmdInput = {
    Bucket: bucket,
    Key: s3Key,
  };

  // Set ResponseContentType so S3 returns the correct Content-Type header
  // (without this, S3 may serve application/octet-stream and the browser won't preview)
  if (mimeType) {
    cmdInput.ResponseContentType = mimeType;
  }

  // For preview (default), serve inline so iframes / <video> / <img> work.
  // For explicit download requests, serve as attachment.
  if (query.disposition === 'attachment') {
    cmdInput.ResponseContentDisposition = `attachment; filename="${encodeURIComponent(file.file_name || 'download')}"`;
  } else {
    cmdInput.ResponseContentDisposition = `inline; filename="${encodeURIComponent(file.file_name || 'file')}"`;
  }

  const cmd = new GetObjectCommand(cmdInput);

  const presignedUrl = await getSignedUrl(s3ForRegion, cmd, {
    expiresIn: STREAM_URL_EXPIRY_SECONDS,
  });

  return {
    url: presignedUrl,
    file_name: file.file_name,
    mime_type: file.mime_type || file.content_type || file.attachments?.[0]?.content_type || '',
    file_size_bytes: file.file_size_bytes || file.attachments?.[0]?.file_size_bytes || 0,
    expires_in: STREAM_URL_EXPIRY_SECONDS,
  };
};

/* ───────────── File Preview URL (view permission only) ───────────── */

const getFilePreviewUrl = async ({ user, project, params, query = {} }) => {
  const file = await getFile({ user, project, params });

  // Only require VIEW permission for preview (not download)
  await DriveFileAccessService.assertFileAccess({ user, project, file, permission: 'view' });

  // Extract S3 key from file_path or attachments
  const s3Key = file.file_path
    || file.attachments?.[0]?.media
    || file.attachments?.[0]?.file_path;

  if (!s3Key) {
    throw new BadRequest('file_has_no_storage_path');
  }

  const attachment = file.attachments?.[0] || {};
  const bucket = attachment.bucket || S3_BUCKET;
  const region = attachment.region || S3_DEFAULT_REGION;

  const s3ForRegion = getS3Client(region);

  const mimeType =
    file.mime_type ||
    file.content_type ||
    attachment.content_type ||
    '';

  const cmdInput = {
    Bucket: bucket,
    Key: s3Key,
  };

  if (mimeType) {
    cmdInput.ResponseContentType = mimeType;
  }

  // Always serve inline for preview
  cmdInput.ResponseContentDisposition = `inline; filename="${encodeURIComponent(file.file_name || 'file')}"`;

  const cmd = new GetObjectCommand(cmdInput);

  const presignedUrl = await getSignedUrl(s3ForRegion, cmd, {
    expiresIn: STREAM_URL_EXPIRY_SECONDS,
  });

  return {
    url: presignedUrl,
    file_name: file.file_name,
    mime_type: file.mime_type || file.content_type || file.attachments?.[0]?.content_type || '',
    file_size_bytes: file.file_size_bytes || file.attachments?.[0]?.file_size_bytes || 0,
    expires_in: STREAM_URL_EXPIRY_SECONDS,
  };
};

/* ───────────── Shareable Link ───────────── */

const SHARE_LINK_EXPIRY_OPTIONS = {
  '1h': 3600,
  '24h': 86400,
  '7d': 604800,
};

const generateShareLink = async ({ user, project, params, body = {} }) => {
  const file = await getFile({ user, project, params });

  // Enforce file-level download permission (sharing generates a download link)
  await DriveFileAccessService.assertFileAccess({ user, project, file, permission: 'download' });

  const s3Key = file.file_path
    || file.attachments?.[0]?.media
    || file.attachments?.[0]?.file_path;

  if (!s3Key) {
    throw new BadRequest('file_has_no_storage_path');
  }

  const attachment = file.attachments?.[0] || {};
  const bucket = attachment.bucket || S3_BUCKET;
  const region = attachment.region || S3_DEFAULT_REGION;
  const s3ForRegion = getS3Client(region);

  const expiryKey = body.expiry || '24h';
  const expiresIn = SHARE_LINK_EXPIRY_OPTIONS[expiryKey] || SHARE_LINK_EXPIRY_OPTIONS['24h'];

  const mimeType = file.mime_type || file.content_type || attachment.content_type || '';

  const cmdInput = {
    Bucket: bucket,
    Key: s3Key,
    ResponseContentDisposition: `inline; filename="${encodeURIComponent(file.file_name || 'file')}"`,
  };

  if (mimeType) {
    cmdInput.ResponseContentType = mimeType;
  }

  const cmd = new GetObjectCommand(cmdInput);
  const presignedUrl = await getSignedUrl(s3ForRegion, cmd, { expiresIn });

  return {
    url: presignedUrl,
    file_name: file.file_name,
    expires_in: expiresIn,
    expiry_label: expiryKey,
  };
};

export default {
  createFile,
  getFiles,
  getFile,
  updateFile,
  deleteFile,
  moveFile,
  getFilesByType,
  getFileStreamUrl,
  getFilePreviewUrl,
  generateShareLink,
};
