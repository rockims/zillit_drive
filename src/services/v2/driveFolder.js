import BadRequest from 'zillit-libs/errors/BadRequest';
import NotificationService from 'zillit-libs/services-v2/notification';
import NotificationRepository from 'zillit-libs/repositories-v2/notification';
import { rights } from 'zillit-libs/services-v2/permissions';
import DriveFolder from 'zillit-libs/mongo-models-v2/DriveFolder';
import DriveFile from 'zillit-libs/mongo-models-v2/DriveFile';

import DriveFolderRepository from '../../repositories/v2/driveFolder.js';
import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFileAccessRepository from '../../repositories/v2/driveFileAccess.js';
import DriveAccessService from './driveAccess.js';
import DriveActivityService from './driveActivity.js';
import DriveNotificationReceivers from './driveNotificationReceivers.js';
import socketClient, { buildUserRooms } from '../../config/socketClient.js';

const {
  sections, tools, units,
} = NotificationService.NotificationConstants;

// Drive-specific constants — not yet in zillit-libs NotificationConstants
const DRIVE_TOOL = 'drive_label';
const DRIVE_UNIT_FOLDER = 'drive_folder_label';

const toIdString = (value) => (value ? value.toString() : null);
const idsEqual = (valueA, valueB) => toIdString(valueA) === toIdString(valueB);

// Field sanitization — prevents injection of protected fields (project_id, created_by, deleted_on, etc.)
const FOLDER_ALLOWED_FIELDS = ['folder_name', 'parent_folder_id', 'description', 'folder_color'];
const pickAllowedFields = (body, allowedFields) => {
  const result = {};
  allowedFields.forEach((field) => {
    if (body[field] !== undefined) result[field] = body[field];
  });
  return result;
};

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

  const sortBy = ['name', 'date', 'created_by', 'uploaded_by', 'size', 'type'].includes(sortByInput)
    ? sortByInput
    : 'date';
  const sortOrder = sortOrderInput === 'asc' ? 'asc' : 'desc';
  const groupBy = ['none', 'created_by', 'uploaded_by', 'path', 'type', 'extension'].includes(groupByInput)
    ? groupByInput
    : 'none';
  const view = ['all', 'files', 'folders'].includes(viewInput) ? viewInput : 'all';
  const quickFilter = ['none', 'mine', 'shared', 'last_7_days', 'large_files', 'recent'].includes(quickFilterInput)
    ? quickFilterInput
    : 'none';

  const rawSearch = String(query.search || '').trim();
  const searchRegex = rawSearch ? new RegExp(escapeRegex(rawSearch), 'i') : null;

  return {
    sortBy,
    sortOrder,
    groupBy,
    view,
    quickFilter,
    searchRegex,
    includeMeta: query.include_meta === 'true',
  };
};

const buildFolderSort = ({ sortBy, sortOrder }) => {
  const direction = sortOrder === 'asc' ? 1 : -1;

  if (sortBy === 'name') {
    return { folder_name: direction, _id: 1 };
  }

  if (sortBy === 'created_by' || sortBy === 'uploaded_by') {
    return { created_by: direction, _id: 1 };
  }

  return { updated_on: direction, created_on: direction, _id: 1 };
};

const buildFolderGrouping = ({ items, groupBy }) => {
  if (groupBy === 'none') {
    return [];
  }

  const buckets = new Map();
  items.forEach((item) => {
    let bucket = 'Unknown';

    if (groupBy === 'created_by') {
      bucket = toIdString(item?.created_by) || 'Unknown';
    } else if (groupBy === 'path') {
      bucket = item?.folder_path || 'Root';
    }

    buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
  });

  return Array.from(buckets.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
};

const buildFolderPath = (parentFolder) => {
  if (!parentFolder) {
    return '';
  }

  return parentFolder.folder_path
    ? `${parentFolder.folder_path}/${parentFolder.folder_name}`
    : parentFolder.folder_name;
};

const _viewingRightsUsers = async (project) => {
  const usersWithRights = await rights.toolUsersRights({
    projectId: project._id,
    identifier: 'drive_tool',
  });
  return usersWithRights.filter((item) => item.view_access).map((item) => item.user_id.toString());
};

const _refreshDescendantPaths = async ({ project, rootFolder, user }) => {
  let parents = [rootFolder];

  while (parents.length > 0) {
    const parentMap = new Map(
      parents.map((folder) => [toIdString(folder._id), folder])
    );

    const children = await DriveFolderRepository.getFolders({
      filters: {
        project_id: project._id,
        parent_folder_id: { $in: parents.map((folder) => folder._id) },
        deleted_on: 0,
      },
      sort: { _id: 1 },
    });

    const nextParents = [];

    for (const child of children) {
      const parent = parentMap.get(toIdString(child.parent_folder_id));
      if (!parent) {
        continue;
      }

      const expectedPath = buildFolderPath(parent);
      if (child.folder_path === expectedPath) {
        nextParents.push(child);
        continue;
      }

      const updatedChild = await DriveFolderRepository.updateFolderDocument({
        filters: {
          _id: child._id,
          project_id: project._id,
          deleted_on: 0,
        },
        data: {
          folder_path: expectedPath,
          updated_by: user._id,
          updated_on: Date.now(),
        },
      });

      nextParents.push(updatedChild || {
        ...child,
        folder_path: expectedPath,
      });
    }

    parents = nextParents;
  }
};

const _getFolderById = async ({ project, folderId }) => DriveFolderRepository.getFolder({
  filters: {
    _id: folderId,
    project_id: project._id,
    deleted_on: 0,
  },
});

const createFolder = async ({ user, project, device, body }) => {
  const normalizedFolderName = body.folder_name.trim().toLowerCase();

  let parentFolder = null;
  if (body.parent_folder_id) {
    parentFolder = await _getFolderById({
      project,
      folderId: body.parent_folder_id,
    });

    if (!parentFolder) {
      throw new BadRequest('parent_folder_not_found');
    }

    await DriveAccessService.assertFolderAccess({
      user,
      project,
      folder: parentFolder,
      minRole: 'editor',
    });
  }

  // ZL-18867: Drive is a Private Drive — duplicate name check must be scoped to
  // the user's own folders, not the entire project. Without created_by here,
  // User B couldn't create a folder named "Mirror" if User A already had one.
  const duplicateFilters = {
    project_id: project._id,
    parent_folder_id: body.parent_folder_id || null,
    created_by: user._id,
    deleted_on: 0,
  };

  const existingFolders = await DriveFolderRepository.getFolders({
    filters: duplicateFilters,
    sort: { _id: 1 },
  });

  const duplicateFolder = existingFolders.find(
    (folder) => folder.folder_name.trim().toLowerCase() === normalizedFolderName
  );

  if (duplicateFolder) {
    throw new BadRequest('duplicate_folder_name');
  }

  const folderBody = pickAllowedFields(body, FOLDER_ALLOWED_FIELDS);

  const data = {
    ...folderBody,
    project_id: project._id,
    created_by: user._id,
    updated_by: user._id,
    folder_path: buildFolderPath(parentFolder),
    is_folder: true,
  };

  const folder = await DriveFolderRepository.createFolder({ data });

  await DriveAccessService.seedFolderAccess({
    project,
    user,
    folder,
    parentFolderId: body.parent_folder_id || null,
  });

  // Grant access to selected users during folder creation (if any)
  if (body.folder_access && body.folder_access.length > 0) {
    try {
      await DriveAccessService.setFolderAccessList({
        user,
        project,
        folder,
        entries: body.folder_access,
        replaceExisting: false,
      });
    } catch (accessError) {
      console.error('[driveFolder] Error granting folder access during creation:', accessError.message);
    }
  }

  // ZL-18799: emit only to users with access (creator + parent-folder ACL +
  // any explicit shares set during creation) instead of the project-wide
  // room. Broadcast was causing folders to appear in unrelated users'
  // "Shared with Me". Wrapped in try/catch — if receiver resolution fails,
  // at minimum the creator still gets the event (multi-device sync).
  let folderEventReceivers = [user._id];
  let notifyReceivers = [];
  try {
    const [parentReceivers, ownAclReceivers] = await Promise.all([
      folder.parent_folder_id
        ? DriveNotificationReceivers.getFolderReceivers({
          project, actorId: user._id, folderId: folder.parent_folder_id,
        })
        : [],
      DriveNotificationReceivers.getFolderReceivers({
        project, actorId: user._id, folderId: folder._id,
      }),
    ]);
    folderEventReceivers = [user._id, ...parentReceivers, ...ownAclReceivers];
    // notifyAll receivers = same union but EXCLUDING the creator (creator is
    // the actor and shouldn't be notified about their own action).
    notifyReceivers = [...new Set([
      ...parentReceivers.map((id) => toIdString(id)).filter(Boolean),
      ...ownAclReceivers.map((id) => toIdString(id)).filter(Boolean),
    ])];
  } catch (err) {
    console.error('[createFolder] receiver resolution failed:', err.message);
  }

  // Send notification:save to recipients so badges actually appear on their
  // side. Previously only the admin socket event (drive:folder:created) was
  // emitted — receivers saw the new folder appear in real-time via the
  // "observer" event but no badge was created because no notification was
  // saved. Mirrors the createFile / completeUpload pattern.
  if (notifyReceivers.length > 0) {
    try {
      const folderCreateLevels = await DriveNotificationReceivers.buildNotificationLevels({
        project,
        folderId: folder.parent_folder_id,
        itemId: folder._id,
      });
      await DriveNotificationReceivers.notifyAllByView({
        payload: {
          project,
          sender: user._id,
          section: sections.TOOLS,
          tool: DRIVE_TOOL,
          action: 'drive_folder_created',
          reference_id: folderCreateLevels.reference_id,
          level_1: folderCreateLevels.level_1,
          level_2: folderCreateLevels.level_2,
          level_3: folderCreateLevels.level_3,
          levels: folderCreateLevels.levels,
          reference_data: {
            folder_id: toIdString(folder._id),
            folder_name: folder.folder_name,
            parent_folder_id: folder.parent_folder_id ? toIdString(folder.parent_folder_id) : null,
          },
          message: `New folder "${folder.folder_name}" created`,
        },
        receivers: notifyReceivers,
        settings: { notify: true, save: true },
        socketClient,
        project,
        level_1: folderCreateLevels.level_1,
        reference_id: folderCreateLevels.reference_id,
        isFile: false,
      });
    } catch (notifErr) {
      console.error('[createFolder] notification dispatch failed:', notifErr.message);
    }
  }

  socketClient('__admin_events__', {
    event: 'drive:folder:created',
    room: buildUserRooms(folderEventReceivers),
    except: device._id,
    data: {
      project_id: project._id,
      device_id: device._id,
      parent_folder_id: folder.parent_folder_id ? toIdString(folder.parent_folder_id) : null,
      folder,
    },
  });

  // Activity log (fire-and-forget)
  DriveActivityService.log({
    projectId: project._id, userId: user._id, action: 'folder_created',
    itemId: folder._id, itemType: 'folder', itemName: folder.folder_name,
  });

  return folder;
};

const getFolders = async ({ user, project, query }) => {
  const listingQuery = parseListingQuery(query);
  const filters = {
    project_id: project._id,
    deleted_on: 0,
  };
  const pagination = parsePagination(query);

  if (listingQuery.view === 'files') {
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

  if (query.parent_folder_id) {
    const parentFolder = await _getFolderById({
      project,
      folderId: query.parent_folder_id,
    });

    if (!parentFolder) {
      throw new BadRequest('parent_folder_not_found');
    }

    // Don't block folder listing if user has no parent folder access —
    // they might have access to child folders or files inside.
    // The `accessibleFolderIds` filter below will ensure they only see
    // child folders they actually have access to.
    try {
      await DriveAccessService.assertFolderAccess({
        user,
        project,
        folder: parentFolder,
        minRole: 'viewer',
      });
    } catch {
      // User has no parent folder access — that's OK.
      // They'll only see child folders they explicitly have access to
      // (enforced by accessibleFolderIds filter below).
    }

    filters.parent_folder_id = query.parent_folder_id;
  } else if (query.parent_folder_id === null || query.root === 'true') {
    filters.parent_folder_id = null;
  }

  const accessibleFolderIds = await DriveAccessService.listAccessibleFolderIds({
    user,
    project,
  });

  if (accessibleFolderIds.length === 0) {
    return pagination.enabled
      ? {
          items: [],
          pagination: {
            total: 0,
            limit: pagination.limit,
            offset: pagination.offset,
            has_more: false,
          },
        }
      : [];
  }
  filters._id = { $in: accessibleFolderIds };

  const andFilters = [filters];

  if (listingQuery.searchRegex) {
    andFilters.push({
      $or: [
        { folder_name: listingQuery.searchRegex },
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
  } else if (listingQuery.quickFilter === 'recent') {
    andFilters.push({ updated_on: { $gte: Date.now() - 30 * 24 * 60 * 60 * 1000 } });
  }

  const finalFilters = andFilters.length === 1 ? andFilters[0] : { $and: andFilters };
  const shouldReturnMeta =
    pagination.enabled || listingQuery.includeMeta || listingQuery.groupBy !== 'none';

  const folders = await DriveFolderRepository.getFolders({
    filters: finalFilters,
    sort: listingQuery.quickFilter === 'recent' ? { updated_on: -1 } : buildFolderSort(listingQuery),
    limit: pagination.enabled ? pagination.limit : null,
    skip: pagination.enabled ? pagination.offset : null,
  });

  // Resolve current user's permissions for each folder
  const ROLE_TO_PERMS = {
    owner: { can_view: true, can_edit: true, can_download: true, can_delete: true },
    editor: { can_view: true, can_edit: true, can_download: true, can_delete: false },
    viewer: { can_view: true, can_edit: false, can_download: false, can_delete: false },
  };
  const foldersWithPermissions = await Promise.all(
    folders.map(async (folder) => {
      const folderObj = typeof folder.toObject === 'function' ? folder.toObject() : { ...folder };
      try {
        const role = await DriveAccessService.resolveFolderRole({ user, project, folder });
        folderObj._userPermissions = role ? (ROLE_TO_PERMS[role] || ROLE_TO_PERMS.viewer) : { can_view: true, can_edit: false, can_download: false, can_delete: false };
      } catch {
        folderObj._userPermissions = { can_view: true, can_edit: false, can_download: false, can_delete: false };
      }
      // Fetch access entries once → derive both count and user id list
      // (web/mobile need _accessUserIds to render shared-user avatars instead of "Only You")
      // DriveFolderAccessRepository.getAccesses does NOT populate today, so e.user_id is an
      // ObjectId. The `_id` fallback keeps this code correct if the repo ever starts populating
      // (same defensive pattern as driveFile above).
      try {
        const accessEntries = await DriveFolderAccessRepository.getAccesses({
          filters: { folder_id: folder._id, project_id: project._id, deleted_on: 0 },
        });
        folderObj._accessCount = accessEntries.length;
        folderObj._accessUserIds = accessEntries
          .map((e) => (e.user_id?._id || e.user_id)?.toString())
          .filter(Boolean);
      } catch {
        folderObj._accessCount = 0;
        folderObj._accessUserIds = [];
      }
      return folderObj;
    }),
  );

  if (!shouldReturnMeta) {
    return foldersWithPermissions;
  }

  const total = await DriveFolderRepository.countFolders({ filters: finalFilters });

  return {
    items: foldersWithPermissions,
    pagination: {
      total,
      limit: pagination.limit,
      offset: pagination.offset,
      has_more: pagination.offset + foldersWithPermissions.length < total,
    },
    grouping: buildFolderGrouping({
      items: foldersWithPermissions,
      groupBy: listingQuery.groupBy,
    }),
  };
};

const getContentSortValue = ({ item, sortBy }) => {
  if (sortBy === 'name') {
    return String(item?.name || '').toLowerCase();
  }

  if (sortBy === 'size') {
    return Number(item?.size || 0);
  }

  if (sortBy === 'uploaded_by' || sortBy === 'created_by') {
    return String(item?.created_by || '');
  }

  if (sortBy === 'type') {
    return String(item?.type || '');
  }

  return Number(item?.date_modified || 0);
};

const buildContentComparator = ({ sortBy, sortOrder }) => {
  const direction = sortOrder === 'asc' ? 1 : -1;

  return (itemA, itemB) => {
    const valueA = getContentSortValue({ item: itemA, sortBy });
    const valueB = getContentSortValue({ item: itemB, sortBy });

    if (valueA > valueB) {
      return direction;
    }
    if (valueA < valueB) {
      return -direction;
    }

    return String(itemA?.name || '').localeCompare(String(itemB?.name || ''));
  };
};

const getContentGroupKey = ({ item, groupBy }) => {
  if (groupBy === 'type') {
    return item?.type === 'folder' ? 'Folders' : 'Files';
  }

  if (groupBy === 'uploaded_by' || groupBy === 'created_by') {
    return toIdString(item?.created_by) || 'Unknown';
  }

  if (groupBy === 'path') {
    return item?.folder_path || 'Root';
  }

  if (groupBy === 'extension') {
    if (item?.type === 'folder') {
      return 'Folder';
    }
    return item?.file_extension || 'No Extension';
  }

  return 'All';
};

const buildContentGrouping = ({ items, groupBy }) => {
  if (groupBy === 'none') {
    return [];
  }

  const buckets = new Map();
  items.forEach((item) => {
    const key = getContentGroupKey({ item, groupBy });
    buckets.set(key, (buckets.get(key) || 0) + 1);
  });

  return Array.from(buckets.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
};

const getDriveContents = async ({ user, project, query }) => {
  const listingQuery = parseListingQuery(query);
  const pagination = parsePagination(query);

  const folderId = query.folder_id || (query.root === 'true' ? null : null);
  const folderFilters = {
    project_id: project._id,
    parent_folder_id: folderId || null,
    deleted_on: 0,
  };
  const fileFilters = {
    project_id: project._id,
    folder_id: folderId || null,
    deleted_on: 0,
  };

  if (folderId) {
    const parentFolder = await _getFolderById({
      project,
      folderId,
    });

    if (!parentFolder) {
      throw new BadRequest('folder_not_found');
    }

    await DriveAccessService.assertFolderAccess({
      user,
      project,
      folder: parentFolder,
      minRole: 'viewer',
    });
  } else {
    // Show root files the user created OR has explicit access to
    const accessibleFileIds = await DriveFileAccessRepository.distinctFileIds({
      filters: {
        project_id: project._id,
        user_id: user._id,
        can_view: true,
        deleted_on: 0,
      },
    });
    fileFilters.$or = [
      { created_by: user._id },
      ...(accessibleFileIds.length > 0 ? [{ _id: { $in: accessibleFileIds } }] : []),
    ];
  }

  const accessibleFolderIds = await DriveAccessService.listAccessibleFolderIds({
    user,
    project,
  });

  folderFilters._id = { $in: accessibleFolderIds };

  if (listingQuery.searchRegex) {
    folderFilters.$or = [
      { folder_name: listingQuery.searchRegex },
      { description: listingQuery.searchRegex },
    ];
    fileFilters.$or = [
      { file_name: listingQuery.searchRegex },
      { description: listingQuery.searchRegex },
    ];
  }

  if (listingQuery.quickFilter === 'mine') {
    folderFilters.created_by = user._id;
    fileFilters.created_by = user._id;
  } else if (listingQuery.quickFilter === 'shared') {
    folderFilters.created_by = { $ne: user._id };
    fileFilters.created_by = { $ne: user._id };
  } else if (listingQuery.quickFilter === 'last_7_days') {
    const lastWeek = Date.now() - 7 * 24 * 60 * 60 * 1000;
    folderFilters.created_on = { $gte: lastWeek };
    fileFilters.created_on = { $gte: lastWeek };
  } else if (listingQuery.quickFilter === 'large_files') {
    fileFilters.file_size_bytes = {
      $gte: Number(query.large_file_threshold_bytes) > 0
        ? Number(query.large_file_threshold_bytes)
        : 100 * 1024 * 1024,
    };
  } else if (listingQuery.quickFilter === 'recent') {
    const lastMonth = Date.now() - 30 * 24 * 60 * 60 * 1000;
    folderFilters.updated_on = { $gte: lastMonth };
    fileFilters.updated_on = { $gte: lastMonth };
  }

  // Build MongoDB sort spec for the aggregation pipeline
  const buildAggSort = () => {
    const direction = listingQuery.sortOrder === 'asc' ? 1 : -1;
    const sortBy = listingQuery.sortBy;
    if (sortBy === 'name') return { _sort_name: direction, _sort_name_tiebreak: 1 };
    if (sortBy === 'size') return { _sort_size: direction, _sort_name_tiebreak: 1 };
    if (sortBy === 'uploaded_by' || sortBy === 'created_by') return { _sort_created_by: direction, _sort_name_tiebreak: 1 };
    if (sortBy === 'type') return { _sort_type: direction, _sort_name_tiebreak: 1 };
    return { _sort_date: direction, _sort_name_tiebreak: 1 };
  };

  const includeFolders = listingQuery.view !== 'files' && listingQuery.quickFilter !== 'large_files';
  const includeFiles = listingQuery.view !== 'folders';

  // Folder projection fields for list view (exclude attachments/description)
  const LIST_PROJECTION = {
    project_id: 1, file_name: 1, file_path: 1, file_type: 1, file_extension: 1,
    file_size: 1, file_size_bytes: 1, mime_type: 1, is_active: 1,
    folder_id: 1, created_by: 1, updated_by: 1, uploaded_by: 1,
    created_on: 1, updated_on: 1, deleted_on: 1,
  };

  const FOLDER_LIST_PROJECTION = {
    project_id: 1, folder_name: 1, folder_path: 1, parent_folder_id: 1,
    is_folder: 1, created_by: 1, updated_by: 1,
    created_on: 1, updated_on: 1, deleted_on: 1,
  };

  // Build folder pipeline stages
  const folderPipeline = [];
  if (includeFolders) {
    folderPipeline.push(
      { $match: folderFilters },
      { $project: FOLDER_LIST_PROJECTION },
      {
        $addFields: {
          type: 'folder',
          is_folder: true,
          name: { $ifNull: ['$folder_name', ''] },
          date_modified: { $ifNull: ['$updated_on', { $ifNull: ['$created_on', 0] }] },
          size: 0,
          file_extension: '',
          _sort_name: { $toLower: { $ifNull: ['$folder_name', ''] } },
          _sort_date: { $ifNull: ['$updated_on', { $ifNull: ['$created_on', 0] }] },
          _sort_size: 0,
          _sort_type: 'folder',
          _sort_created_by: { $toString: { $ifNull: ['$created_by', ''] } },
          _sort_name_tiebreak: { $toLower: { $ifNull: ['$folder_name', ''] } },
        },
      }
    );
  }

  // Build file pipeline stages for $unionWith
  const filePipeline = [];
  if (includeFiles) {
    filePipeline.push(
      { $match: fileFilters },
      { $project: LIST_PROJECTION },
      {
        $addFields: {
          type: 'file',
          is_folder: false,
          name: { $ifNull: ['$file_name', ''] },
          date_modified: { $ifNull: ['$updated_on', { $ifNull: ['$created_on', 0] }] },
          size: { $ifNull: ['$file_size_bytes', 0] },
          file_extension: { $ifNull: ['$file_extension', ''] },
          _sort_name: { $toLower: { $ifNull: ['$file_name', ''] } },
          _sort_date: { $ifNull: ['$updated_on', { $ifNull: ['$created_on', 0] }] },
          _sort_size: { $ifNull: ['$file_size_bytes', 0] },
          _sort_type: 'file',
          _sort_created_by: { $toString: { $ifNull: ['$created_by', ''] } },
          _sort_name_tiebreak: { $toLower: { $ifNull: ['$file_name', ''] } },
        },
      }
    );
  }

  // Build the complete aggregation pipeline
  const pipeline = [];

  if (includeFolders && includeFiles) {
    // Start with folders, union with files
    pipeline.push(...folderPipeline);
    pipeline.push({
      $unionWith: {
        coll: DriveFile.collection.name,
        pipeline: filePipeline,
      },
    });
  } else if (includeFolders) {
    pipeline.push(...folderPipeline);
  } else if (includeFiles) {
    // Start from files collection directly via aggregation
    // We need to run on the correct collection, so use DriveFile.aggregate later
  }

  // For files-only view, run on DriveFile collection
  if (!includeFolders && includeFiles) {
    const fileOnlyPipeline = [
      ...filePipeline,
      { $sort: buildAggSort() },
      {
        $facet: {
          items: pagination.enabled
            ? [{ $skip: pagination.offset }, { $limit: pagination.limit }]
            : [{ $limit: 10000 }],
          totalCount: [{ $count: 'count' }],
          folderCount: [{ $match: { is_folder: true } }, { $count: 'count' }],
          fileCount: [{ $match: { is_folder: false } }, { $count: 'count' }],
        },
      },
    ];

    const [aggResult] = await DriveFile.aggregate(fileOnlyPipeline);
    const items = aggResult?.items || [];
    const total = aggResult?.totalCount?.[0]?.count || 0;
    const folderTotal = aggResult?.folderCount?.[0]?.count || 0;
    const fileTotal = aggResult?.fileCount?.[0]?.count || 0;

    return {
      items,
      pagination: {
        total,
        limit: pagination.limit,
        offset: pagination.offset,
        has_more: pagination.offset + items.length < total,
      },
      counts: { folders: folderTotal, files: fileTotal, total },
      grouping: buildContentGrouping({ items, groupBy: listingQuery.groupBy }),
    };
  }

  // Sort and paginate at DB level
  pipeline.push({ $sort: buildAggSort() });
  pipeline.push({
    $facet: {
      items: pagination.enabled
        ? [{ $skip: pagination.offset }, { $limit: pagination.limit }]
        : [{ $limit: 10000 }],
      totalCount: [{ $count: 'count' }],
      folderCount: [{ $match: { is_folder: true } }, { $count: 'count' }],
      fileCount: [{ $match: { is_folder: false } }, { $count: 'count' }],
    },
  });

  const [aggResult] = await DriveFolder.aggregate(pipeline);
  const items = aggResult?.items || [];
  const total = aggResult?.totalCount?.[0]?.count || 0;
  const folderTotal = aggResult?.folderCount?.[0]?.count || 0;
  const fileTotal = aggResult?.fileCount?.[0]?.count || 0;

  return {
    items,
    pagination: {
      total,
      limit: pagination.limit,
      offset: pagination.offset,
      has_more: pagination.offset + items.length < total,
    },
    counts: { folders: folderTotal, files: fileTotal, total },
    grouping: buildContentGrouping({ items, groupBy: listingQuery.groupBy }),
  };
};

const getFolder = async ({ user, project, params }) => {
  const folder = await _getFolderById({
    project,
    folderId: params.folderId,
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

  return folder;
};

const updateFolder = async ({ user, project, device, params, body }) => {
  const folderId = params.folderId || body.folder_id;

  if (!folderId) {
    throw new BadRequest('folder_id_required');
  }

  const existingFolder = await _getFolderById({
    project,
    folderId,
  });

  if (!existingFolder) {
    throw new BadRequest('folder_not_found');
  }

  await DriveAccessService.assertFolderAccess({
    user,
    project,
    folder: existingFolder,
    minRole: 'editor',
  });

  const requestedParentId = body.parent_folder_id !== undefined
    ? body.parent_folder_id
    : existingFolder.parent_folder_id;

  let nextParentFolder = null;
  if (requestedParentId) {
    if (idsEqual(requestedParentId, folderId)) {
      throw new BadRequest('invalid_parent_folder');
    }

    const descendantIds = await DriveAccessService.collectDescendantFolderIds({
      projectId: project._id,
      rootFolderId: existingFolder._id,
      includeRoot: false,
    });

    if (descendantIds.includes(toIdString(requestedParentId))) {
      throw new BadRequest('invalid_parent_folder');
    }

    nextParentFolder = await _getFolderById({
      project,
      folderId: requestedParentId,
    });

    if (!nextParentFolder) {
      throw new BadRequest('parent_folder_not_found');
    }

    await DriveAccessService.assertFolderAccess({
      user,
      project,
      folder: nextParentFolder,
      minRole: 'editor',
    });
  }

  const nextFolderName = body.folder_name || existingFolder.folder_name;
  const normalizedFolderName = nextFolderName.trim().toLowerCase();

  // ZL-18867: scope duplicate check to the user's own folders (Private Drive).
  const duplicateFilters = {
    project_id: project._id,
    parent_folder_id: requestedParentId || null,
    created_by: user._id,
    deleted_on: 0,
    _id: { $ne: folderId },
  };

  const sameParentFolders = await DriveFolderRepository.getFolders({
    filters: duplicateFilters,
    sort: { _id: 1 },
  });

  const duplicateFolder = sameParentFolders.find(
    (folder) => folder.folder_name.trim().toLowerCase() === normalizedFolderName
  );

  if (duplicateFolder) {
    throw new BadRequest('duplicate_folder_name');
  }

  const sanitizedBody = pickAllowedFields(body, FOLDER_ALLOWED_FIELDS);

  const movingParent = !idsEqual(requestedParentId, existingFolder.parent_folder_id);
  const renaming = body.folder_name && body.folder_name !== existingFolder.folder_name;

  const updateData = {
    ...sanitizedBody,
    parent_folder_id: requestedParentId || null,
    updated_by: user._id,
    updated_on: Date.now(),
    is_folder: true,
  };

  if (movingParent) {
    updateData.folder_path = buildFolderPath(nextParentFolder);
  }

  const updatedFolder = await DriveFolderRepository.updateFolderDocument({
    filters: {
      _id: folderId,
      project_id: project._id,
      deleted_on: 0,
    },
    data: updateData,
  });

  if (!updatedFolder) {
    throw new BadRequest('folder_update_failed');
  }

  if (movingParent || renaming) {
    await _refreshDescendantPaths({
      project,
      rootFolder: updatedFolder,
      user,
    });
  }

  const [folderUpdateReceiverIds, folderUpdateLevels] = await Promise.all([
    DriveNotificationReceivers.getFolderReceivers({
      project,
      actorId: user._id,
      folderId: updatedFolder._id,
    }),
    DriveNotificationReceivers.buildNotificationLevels({
      project,
      folderId: updatedFolder.parent_folder_id,
      itemId: updatedFolder._id,
    }),
  ]);

  if (folderUpdateReceiverIds.length > 0) {
    await DriveNotificationReceivers.notifyAllByView({
      payload: {
        project,
        sender: user._id,
        section: sections.TOOLS,
        tool: DRIVE_TOOL,
        action: 'drive_folder_updated',
        reference_id: folderUpdateLevels.reference_id,
        level_1: folderUpdateLevels.level_1,
        level_2: folderUpdateLevels.level_2,
        level_3: folderUpdateLevels.level_3,
        levels: folderUpdateLevels.levels,
        reference_data: {
          folder_id: toIdString(updatedFolder._id),
          folder_name: updatedFolder.folder_name,
          parent_folder_id: updatedFolder.parent_folder_id ? toIdString(updatedFolder.parent_folder_id) : null,
        },
        message: `Folder "${updatedFolder.folder_name}" updated`,
      },
      receivers: folderUpdateReceiverIds,
      settings: { notify: true, save: true },
      socketClient,
      project,
      level_1: folderUpdateLevels.level_1,
      reference_id: folderUpdateLevels.reference_id,
      isFile: false,
    });
  }

  socketClient('__admin_events__', {
    event: 'drive:folder:updated',
    room: `${project._id.toString()}_room`,
    data: {
      project_id: project._id,
      device_id: device._id,
      parent_folder_id: updatedFolder.parent_folder_id ? toIdString(updatedFolder.parent_folder_id) : null,
      folder: updatedFolder,
    },
  });

  // Activity log (fire-and-forget)
  DriveActivityService.log({
    projectId: project._id, userId: user._id, action: 'folder_updated',
    itemId: updatedFolder._id, itemType: 'folder', itemName: updatedFolder.folder_name,
  });

  return updatedFolder;
};

const deleteFolder = async ({ user, project, device, params }) => {
  const folder = await _getFolderById({
    project,
    folderId: params.folderId,
  });

  if (!folder) {
    throw new BadRequest('folder_not_found');
  }

  // Only owner/admin can delete folders
  await DriveAccessService.assertFolderAccess({
    user,
    project,
    folder,
    minRole: 'owner',
  });

  const folderIds = await DriveAccessService.collectDescendantFolderIds({
    projectId: project._id,
    rootFolderId: folder._id,
    includeRoot: true,
  });

  const deleteTimestamp = Date.now();
  const deleteData = {
    deleted_on: deleteTimestamp,
    updated_by: user._id,
    updated_on: deleteTimestamp,
  };

  const filesToDelete = await DriveFileRepository.countFiles({
    filters: {
      project_id: project._id,
      folder_id: { $in: folderIds },
      deleted_on: 0,
    },
  });

  await Promise.all([
    DriveFileRepository.updateFiles({
      filters: {
        project_id: project._id,
        folder_id: { $in: folderIds },
        deleted_on: 0,
      },
      data: deleteData,
    }),
    DriveFolderRepository.updateFolders({
      filters: {
        project_id: project._id,
        _id: { $in: folderIds },
        deleted_on: 0,
      },
      data: deleteData,
    }),
    DriveAccessService.softDeleteFolderAccess({
      projectId: project._id,
      folderIds,
      data: deleteData,
    }),
  ]);

  const [folderDeleteReceiverIds, folderDeleteLevels] = await Promise.all([
    DriveNotificationReceivers.getFolderReceivers({
      project,
      actorId: user._id,
      folderId: folder._id,
    }),
    DriveNotificationReceivers.buildNotificationLevels({
      project,
      folderId: folder.parent_folder_id,
      itemId: folder._id,
    }),
  ]);

  if (folderDeleteReceiverIds.length > 0) {
    await DriveNotificationReceivers.notifyAllByView({
      payload: {
        project,
        sender: user._id,
        section: sections.TOOLS,
        tool: DRIVE_TOOL,
        action: 'drive_folder_deleted',
        reference_id: folderDeleteLevels.reference_id,
        level_1: folderDeleteLevels.level_1,
        level_2: folderDeleteLevels.level_2,
        level_3: folderDeleteLevels.level_3,
        levels: folderDeleteLevels.levels,
        reference_data: {
          folder_id: toIdString(folder._id),
          folder_name: folder.folder_name,
          parent_folder_id: folder.parent_folder_id ? toIdString(folder.parent_folder_id) : null,
        },
        message: `Folder "${folder.folder_name}" deleted`,
      },
      receivers: folderDeleteReceiverIds,
      settings: { notify: true, save: true },
      socketClient,
      project,
      level_1: folderDeleteLevels.level_1,
      reference_id: folderDeleteLevels.reference_id,
      isFile: false,
    });
  }

  socketClient('__admin_events__', {
    event: 'drive:folder:deleted',
    room: `${project._id.toString()}_room`,
    data: {
      project_id: project._id,
      device_id: device._id,
      parent_folder_id: folder.parent_folder_id ? toIdString(folder.parent_folder_id) : null,
      folder,
    },
  });

  // Activity log (fire-and-forget)
  DriveActivityService.log({
    projectId: project._id, userId: user._id, action: 'folder_deleted',
    itemId: folder._id, itemType: 'folder', itemName: folder.folder_name,
    details: { deletedFiles: filesToDelete, deletedSubfolders: Math.max(folderIds.length - 1, 0) },
  });

  return {
    message: 'Folder deleted successfully',
    deletedFiles: filesToDelete,
    deletedSubfolders: Math.max(folderIds.length - 1, 0),
  };
};

const getFolderContents = async ({ user, project, params }) => {
  const folder = await _getFolderById({
    project,
    folderId: params.folderId,
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

  const accessibleFolderIds = await DriveAccessService.listAccessibleFolderIds({
    user,
    project,
  });

  const subfolderFilters = {
    parent_folder_id: folder._id,
    project_id: project._id,
    deleted_on: 0,
  };

  if (accessibleFolderIds !== null) {
    subfolderFilters._id = { $in: accessibleFolderIds };
  }

  const subfolders = await DriveFolderRepository.getFolders({
    filters: subfolderFilters,
    sort: { created_on: -1 },
  });

  const files = await DriveFileRepository.getFiles({
    filters: {
      folder_id: folder._id,
      project_id: project._id,
      deleted_on: 0,
    },
    sort: { created_on: -1 },
  });

  return {
    folder,
    subfolders,
    files,
  };
};

const getFolderAccess = async ({ user, project, params }) => {
  const folder = await _getFolderById({
    project,
    folderId: params.folderId,
  });

  if (!folder) {
    throw new BadRequest('folder_not_found');
  }

  return DriveAccessService.getFolderAccessList({
    user,
    project,
    folder,
  });
};

const updateFolderAccess = async ({ user, project, params, body }) => {
  const folder = await _getFolderById({
    project,
    folderId: params.folderId,
  });

  if (!folder) {
    throw new BadRequest('folder_not_found');
  }

  return DriveAccessService.setFolderAccessList({
    user,
    project,
    folder,
    entries: body.entries || [],
    replaceExisting: body.replace_existing === true,
  });
};

const inheritFolderAccess = async ({ user, project, params }) => {
  const folder = await _getFolderById({
    project,
    folderId: params.folderId,
  });

  if (!folder) {
    throw new BadRequest('folder_not_found');
  }

  return DriveAccessService.inheritFolderAccessToDescendants({
    user,
    project,
    folder,
  });
};

/* ───────────── Move Folder ───────────── */

const moveFolder = async ({ user, project, device, params, body }) => {
  const { folderId } = params;
  const { target_folder_id } = body;

  // 1. Fetch the folder being moved
  const folder = await _getFolderById({ project, folderId });
  if (!folder) throw new BadRequest('folder_not_found');

  // 2. Prevent no-op moves
  if (idsEqual(folder.parent_folder_id, target_folder_id || null)) {
    throw new BadRequest('folder_already_in_target');
  }

  // 3. Prevent moving a folder into itself
  if (idsEqual(folderId, target_folder_id)) {
    throw new BadRequest('cannot_move_folder_into_itself');
  }

  // 4. Check editor access on the source folder's parent (or root)
  if (folder.parent_folder_id) {
    const sourceParent = await _getFolderById({ project, folderId: folder.parent_folder_id });
    if (sourceParent) {
      await DriveAccessService.assertFolderAccess({
        user, project, folder: sourceParent, minRole: 'editor',
      });
    }
  }

  // 5. Check editor access on the target folder (if not root)
  if (target_folder_id) {
    const targetFolder = await _getFolderById({ project, folderId: target_folder_id });
    if (!targetFolder) throw new BadRequest('target_folder_not_found');

    await DriveAccessService.assertFolderAccess({
      user, project, folder: targetFolder, minRole: 'editor',
    });

    // 6. Prevent moving a folder into its own descendant (circular reference)
    const descendantIds = await DriveAccessService.collectDescendantFolderIds({
      projectId: project._id, rootFolderId: folderId,
    });
    const descendantStrings = descendantIds.map((id) => id.toString());
    if (descendantStrings.includes(target_folder_id.toString())) {
      throw new BadRequest('cannot_move_folder_into_descendant');
    }
  }

  // 7. Check for duplicate folder name in target
  // ZL-18867: scope duplicate check to the user's own folders (Private Drive).
  const duplicateFolder = await DriveFolderRepository.getFolder({
    filters: {
      project_id: project._id,
      parent_folder_id: target_folder_id || null,
      created_by: user._id,
      deleted_on: 0,
      _id: { $ne: folderId },
      folder_name: { $regex: new RegExp(`^${escapeRegex(folder.folder_name.trim())}$`, 'i') },
    },
  });
  if (duplicateFolder) throw new BadRequest('duplicate_folder_name');

  // 8. Update the folder's parent
  const updatedFolder = await DriveFolderRepository.updateFolder({
    filters: { _id: folderId },
    data: {
      parent_folder_id: target_folder_id || null,
      updated_by: user._id,
      updated_on: Date.now(),
    },
  });

  // 9. Refresh descendant folder paths
  await _refreshDescendantPaths({ project, rootFolder: updatedFolder, user });

  // 9.5 Reconcile inherited access records from the new parent
  if (target_folder_id) {
    const targetFolder = await DriveFolderRepository.getFolder({
      filters: { _id: target_folder_id, project_id: project._id, deleted_on: 0 },
    });
    if (targetFolder) {
      await DriveAccessService.inheritFolderAccessToDescendants({
        user, project, folder: targetFolder,
      });
    }
  }

  // ZL-18871/-18872/-18873: emit move notification with fresh ancestry +
  // silent-mark prior unread badges that carry stale level_1..level_3.
  //
  // Two problems before:
  //   (1) moveFolder didn't notify anyone — only fired the admin socket event,
  //       so receivers never got a `notification:save` for folder moves.
  //   (2) Existing badges for the moved folder still carried the OLD ancestry
  //       (level_1=folder._id when it was at root, etc.). The FE rollup keys
  //       off those levels — after the move, the old badge no longer rolls up
  //       to the new ancestor (e.g., the new parent's badge count is wrong).
  //
  // Fix mirrors the share/revoke pattern in driveFileAccess.setFileAccessList:
  //   - find prior unread notifications referencing this folder, mark them read
  //   - emit `notification:silent` with read_notification_ids so FE drops them
  //   - emit fresh `notification:save` with new levels reflecting current path
  try {
    const sourceFolderId = folder.parent_folder_id ? toIdString(folder.parent_folder_id) : null;
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
        folderId: updatedFolder.parent_folder_id || updatedFolder._id,
        itemId: updatedFolder._id,
      }),
    ]);

    // Also include direct sharees on the folder itself — they need to know
    // their shared folder moved even if they have no role on src/target.
    const folderOwnSharees = await DriveNotificationReceivers.getFolderReceivers({
      project, actorId: user._id, folderId: updatedFolder._id,
    });
    const allReceiverIds = Array.from(new Set([
      ...moveReceiverIds.map(toIdString),
      ...folderOwnSharees.map(toIdString),
    ])).filter(Boolean);

    if (allReceiverIds.length > 0) {
      // Silent-mark prior unread notifications for THIS folder. Their levels
      // reflect the pre-move ancestry and would otherwise produce stale
      // rollups in the FE BadgeDB cache.
      const priorMoveFilters = {
        project_id: project._id,
        receiver: { $in: allReceiverIds },
        reference_id: toIdString(updatedFolder._id),
        message_read: false,
      };

      const priorReadIds = await NotificationRepository.getNotificationIDs({
        filters: priorMoveFilters,
        field: 'notification_uuid',
      });

      if (priorReadIds.length > 0) {
        await NotificationRepository.updateNotification({
          filters: priorMoveFilters,
          data: { message_read: true },
        });

        await DriveNotificationReceivers.notifyAllByView({
          payload: {
            project,
            sender: user._id,
            section: sections.TOOLS,
            tool: DRIVE_TOOL,
            action: 'drive_folder_moved',
            reference_id: moveNotifLevels.reference_id,
            level_1: moveNotifLevels.level_1,
            level_2: moveNotifLevels.level_2,
            level_3: moveNotifLevels.level_3,
            levels: moveNotifLevels.levels,
            reference_data: {
              folder_id: toIdString(updatedFolder._id),
              folder_name: updatedFolder.folder_name,
              source_parent_id: sourceFolderId,
              target_parent_id: movedTargetFolderId,
              read_notification_ids: priorReadIds.filter(Boolean),
            },
          },
          receivers: allReceiverIds,
          settings: { save: false, silent: true },
          socketClient,
          project,
          level_1: moveNotifLevels.level_1,
          reference_id: moveNotifLevels.reference_id,
          isFile: false,
        });
      }

      await DriveNotificationReceivers.notifyAllByView({
        payload: {
          project,
          sender: user._id,
          section: sections.TOOLS,
          tool: DRIVE_TOOL,
          action: 'drive_folder_moved',
          reference_id: moveNotifLevels.reference_id,
          level_1: moveNotifLevels.level_1,
          level_2: moveNotifLevels.level_2,
          level_3: moveNotifLevels.level_3,
          levels: moveNotifLevels.levels,
          reference_data: {
            folder_id: toIdString(updatedFolder._id),
            folder_name: updatedFolder.folder_name,
            source_parent_id: sourceFolderId,
            target_parent_id: movedTargetFolderId,
          },
          message: `Folder "${updatedFolder.folder_name}" moved`,
        },
        receivers: allReceiverIds,
        settings: { notify: true, save: true },
        socketClient,
        project,
        level_1: moveNotifLevels.level_1,
        reference_id: moveNotifLevels.reference_id,
        isFile: false,
      });
    }
  } catch (err) {
    // Notification path is non-fatal — the move itself already succeeded.
    console.error('[moveFolder_notify_failed]:', err.message);
  }

  // 10. Socket emit for real-time updates
  socketClient('__admin_events__', {
    event: 'drive:folder:moved',
    room: `${project._id.toString()}_room`,
    data: {
      project_id: project._id,
      device_id: device?._id || null,
      folder_id: folderId,
      source_parent_id: folder.parent_folder_id ? folder.parent_folder_id.toString() : null,
      target_parent_id: target_folder_id || null,
      folder: updatedFolder,
    },
  });

  // Activity log (fire-and-forget)
  DriveActivityService.log({
    projectId: project._id, userId: user._id, action: 'folder_moved',
    itemId: updatedFolder._id, itemType: 'folder', itemName: updatedFolder.folder_name,
    details: { target_folder_id: target_folder_id || null },
  });

  return updatedFolder;
};

export default {
  createFolder,
  getDriveContents,
  getFolders,
  getFolder,
  updateFolder,
  moveFolder,
  deleteFolder,
  getFolderContents,
  getFolderAccess,
  updateFolderAccess,
  inheritFolderAccess,
};
