import BadRequest from 'zillit-libs/errors/BadRequest';
import NotificationService from 'zillit-libs/services-v2/notification';
import NotificationRepository from 'zillit-libs/repositories-v2/notification';
import { rights } from 'zillit-libs/services-v2/permissions';
import DriveFolder from 'zillit-libs/mongo-models-v2/DriveFolder';
import DriveFile from 'zillit-libs/mongo-models-v2/DriveFile';

import DriveFolderRepository from '../../repositories/v2/driveFolder.js';
import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFileAccessRepository from '../../repositories/v2/driveFileAccess.js';
import DriveFolderAccessRepository from '../../repositories/v2/driveFolderAccess.js';
import DriveAccessService from './driveAccess.js';
import DriveActivityService from './driveActivity.js';
import DriveNameResolver from './driveNameResolver.js';
import DriveNotificationReceivers from './driveNotificationReceivers.js';
import socketClient, { buildUserRooms } from '../../config/socketClient.js';

const {
  sections, tools, units,
} = NotificationService.NotificationConstants;

// Drive-specific constants — not yet in zillit-libs NotificationConstants
const DRIVE_TOOL = 'drive_label';
const DRIVE_UNIT_FOLDER = 'drive_folder_label';
const DRIVE_UNIT_FILE = 'drive_file_label';

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
  const quickFilter = ['none', 'mine', 'shared', 'shared_by_me', 'last_7_days', 'large_files', 'recent'].includes(quickFilterInput)
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

  // Never block on duplicate — auto-suffix " (N)" within the user's own
  // namespace (Private Drive, ZL-18867). body.folder_name is overwritten
  // with the resolved name so pickAllowedFields below picks it up.
  body.folder_name = await DriveNameResolver.resolveAvailableFolderName({
    folderName: body.folder_name,
    projectId: project._id,
    parentFolderId: body.parent_folder_id,
    createdBy: user._id,
  });

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
    // ZL-19656: the `drive_folder_created` BADGE must go ONLY to users who
    // see the new folder appear inside a parent they already have access to
    // (parentReceivers). Users explicitly shared on the new folder during
    // creation (body.folder_access → setFolderAccessList above) ALREADY get
    // a `drive_folder_shared` notification — also sending them
    // `drive_folder_created` produced a DOUBLE badge + double notification on
    // the receiver side (the reported bug). So:
    //   - drop ownAclReceivers (the new folder's own ACL = explicit share
    //     targets + parent-inherited; the inherited ones are already in
    //     parentReceivers, the explicit ones get drive_folder_shared), and
    //   - defensively exclude any explicit folder_access target that also
    //     happens to be a parent sharee (otherwise they'd still double up).
    // The real-time `drive:folder:created` socket below is unchanged — it
    // still fans out to folderEventReceivers (incl. share targets) so the
    // folder appears in everyone's list instantly; only the redundant badge
    // is removed.
    const explicitShareTargetIds = new Set(
      (body.folder_access || [])
        .map((entry) => toIdString(entry?.user_id))
        .filter(Boolean),
    );
    notifyReceivers = [...new Set(
      parentReceivers.map((id) => toIdString(id)).filter(Boolean),
    )].filter((id) => !explicitShareTargetIds.has(id));
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
      // ZL-18798: route badge to My Drive / Shared with Me tab via level_1
      // sub-unit. For createFolder, the relevant owner is the PARENT folder's
      // owner (the new folder is INSIDE that parent on the receiver's side).
      // Root-level folder → parent.created_by = null → all receivers go to
      // Shared with Me (they were given access via explicit share).
      await DriveNotificationReceivers.notifyAllTabRouted({
        project,
        actor: user,
        receiverIds: notifyReceivers,
        parentFolderOwnerId: parentFolder?.created_by || null,
        folderId: folder.parent_folder_id,
        itemId: folder._id,
        unit: DRIVE_UNIT_FOLDER,
        action: 'drive_folder_created',
        message: `New folder "${folder.folder_name}" created`,
        referenceData: {
          folder_id: toIdString(folder._id),
          folder_name: folder.folder_name,
          parent_folder_id: folder.parent_folder_id ? toIdString(folder.parent_folder_id) : null,
        },
        socketClient,
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
  } else if (listingQuery.quickFilter === 'shared_by_me') {
    // ZL-19247: folders I own that I have shared with at least one other user.
    // Resolve via DriveFolderAccess: rows where created_by=me and user_id≠me
    // yield the set of folder_ids I've actually shared. Narrow to created_by=me
    // so we don't surface folders I merely re-granted on behalf of someone else.
    //
    // ZL-19251 / ZL-19248: filter out soft-deleted access rows (`deleted_on:
    // 0`). Unshare uses `softDeleteFolderAccess` which only sets
    // `deleted_on != 0` — the row stays in the collection. Without this
    // guard, revoking a share leaves the folder visible under the Shared
    // By Me filter forever (the symptom Vishal reported on the 25th).
    const sharedFolderIds = await DriveFolderAccessRepository.distinctFolderIds({
      filters: {
        project_id: project._id,
        user_id: { $ne: user._id },
        created_by: user._id,
        deleted_on: 0,
      },
    });
    andFilters.push({ created_by: user._id, _id: { $in: sharedFolderIds } });
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

  // Shared-tab sort: order by access timestamp instead of the DB-level
  // updated_on default. Two flavors:
  //   - `shared`        (Shared with me): use DriveFolderAccess.created_on
  //                     where user_id=me — when the folder was shared TO me.
  //   - `shared_by_me`: use DriveFolderAccess.created_on where
  //                     created_by=me and user_id≠me — when I last shared
  //                     the folder with anyone (re-shares bump to top).
  //                     NOTE: folder access uses `created_by` to record the
  //                     granter (file access uses `granted_by`); we mirror
  //                     the same predicate as the visibility filter above.
  // A folder with no matching access row (project-visible via role rights,
  // not directly shared) gets shared_at=0 and falls to the end. We expose
  // `_sharedAt` on the response for the FE to render "Shared on …".
  //
  // NOTE on pagination: the DB query above was already sliced by
  // limit/offset using buildFolderSort. Re-sorting only this page is fine
  // while the FE fetches the whole list in one shot. If pagination is
  // later enabled for these tabs, the join needs to move into the DB
  // query (aggregation $lookup).
  if (
    (listingQuery.quickFilter === 'shared' || listingQuery.quickFilter === 'shared_by_me')
    && foldersWithPermissions.length > 0
  ) {
    const folderIds = foldersWithPermissions.map((f) => f._id);
    const accessFilter = {
      project_id: project._id,
      folder_id: { $in: folderIds },
      deleted_on: 0,
    };
    if (listingQuery.quickFilter === 'shared') {
      accessFilter.user_id = user._id;
    } else {
      // shared_by_me — rows where I granted access to someone else.
      accessFilter.created_by = user._id;
      accessFilter.user_id = { $ne: user._id };
    }
    const myAccesses = await DriveFolderAccessRepository.getAccesses({
      filters: accessFilter,
    });
    const sharedAtByFolderId = new Map();
    for (const a of myAccesses) {
      const fid = String(a.folder_id?._id || a.folder_id);
      const t = a.created_on || 0;
      // Multiple rows possible: re-share after delete OR one row per
      // recipient in shared_by_me — keep the max either way.
      if (!sharedAtByFolderId.has(fid) || sharedAtByFolderId.get(fid) < t) {
        sharedAtByFolderId.set(fid, t);
      }
    }
    for (const f of foldersWithPermissions) {
      f._sharedAt = sharedAtByFolderId.get(String(f._id)) || 0;
    }
    foldersWithPermissions.sort((a, b) => (b._sharedAt || 0) - (a._sharedAt || 0));
  }

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
  } else if (listingQuery.quickFilter === 'shared_by_me') {
    // ZL-19247: items I own (folders + files) that I have shared with at least
    // one other user. Two parallel lookups against the access collections.
    //
    // ZL-19251 / ZL-19248: filter out soft-deleted access rows on BOTH
    // sides. Unshare uses `softDeleteFolderAccess` /
    // `softDeleteFileAccess` which only sets `deleted_on != 0`; without
    // this guard, revoked items still surface under Shared By Me.
    const [sharedFolderIds, sharedFileIds] = await Promise.all([
      DriveFolderAccessRepository.distinctFolderIds({
        filters: {
          project_id: project._id,
          user_id: { $ne: user._id },
          created_by: user._id,
          deleted_on: 0,
        },
      }),
      DriveFileAccessRepository.distinctFileIds({
        filters: {
          project_id: project._id,
          user_id: { $ne: user._id },
          granted_by: user._id,
          deleted_on: 0,
        },
      }),
    ]);
    folderFilters.created_by = user._id;
    folderFilters._id = { $in: sharedFolderIds };
    fileFilters.created_by = user._id;
    fileFilters._id = { $in: sharedFileIds };
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

    await _enrichContentsWithSharedAt({
      items, user, project, quickFilter: listingQuery.quickFilter,
    });

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

  await _enrichContentsWithSharedAt({
    items, user, project, quickFilter: listingQuery.quickFilter,
  });

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

// Mirror of the per-endpoint shared-tab post-sort for the unified
// /folders/contents aggregation pipeline. The aggregation returns a mixed
// array of files + folders, so we batch-lookup BOTH access collections in
// parallel, build a single id→shared_at map, annotate each item with
// `_sharedAt`, and re-sort. No-op for any other quick_filter — items are
// returned in the DB-side _sort_date order (updated_on desc).
//
// Pagination caveat applies here too: the aggregation pre-sliced by
// _sort_date, so re-sorting only the current page is correct ONLY when
// the FE asks for the whole list in one shot. A future migration of this
// join into a $lookup stage would fix that.
const _enrichContentsWithSharedAt = async ({
  items, user, project, quickFilter,
}) => {
  if (
    (quickFilter !== 'shared' && quickFilter !== 'shared_by_me')
    || !items
    || items.length === 0
  ) {
    return;
  }

  const fileIds = [];
  const folderIds = [];
  for (const it of items) {
    if (it?.is_folder) folderIds.push(it._id);
    else fileIds.push(it._id);
  }

  const folderAccessFilter = folderIds.length > 0 ? {
    project_id: project._id,
    folder_id: { $in: folderIds },
    deleted_on: 0,
    ...(quickFilter === 'shared'
      ? { user_id: user._id }
      : { created_by: user._id, user_id: { $ne: user._id } }),
  } : null;

  const fileAccessFilter = fileIds.length > 0 ? {
    project_id: project._id,
    file_id: { $in: fileIds },
    deleted_on: 0,
    ...(quickFilter === 'shared'
      ? { user_id: user._id }
      : { granted_by: user._id, user_id: { $ne: user._id } }),
  } : null;

  const [folderAccesses, fileAccesses] = await Promise.all([
    folderAccessFilter
      ? DriveFolderAccessRepository.getAccesses({ filters: folderAccessFilter })
      : Promise.resolve([]),
    fileAccessFilter
      ? DriveFileAccessRepository.getAccesses({ filters: fileAccessFilter })
      : Promise.resolve([]),
  ]);

  // Single id→shared_at map keyed by string id. Files and folders cannot
  // share ObjectId values across collections in practice, so a flat map
  // is safe.
  const sharedAtById = new Map();
  const upsertMax = (id, t) => {
    const key = String(id);
    if (!sharedAtById.has(key) || sharedAtById.get(key) < t) {
      sharedAtById.set(key, t);
    }
  };
  for (const a of folderAccesses) {
    upsertMax(a.folder_id?._id || a.folder_id, a.created_on || 0);
  }
  for (const a of fileAccesses) {
    upsertMax(a.file_id?._id || a.file_id, a.created_on || 0);
  }

  for (const it of items) {
    it._sharedAt = sharedAtById.get(String(it._id)) || 0;
  }
  items.sort((a, b) => (b._sharedAt || 0) - (a._sharedAt || 0));
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

  const [folderUpdateReceiverIds, parentFolderForUpdate] = await Promise.all([
    DriveNotificationReceivers.getFolderReceivers({
      project,
      actorId: user._id,
      folderId: updatedFolder._id,
    }),
    updatedFolder.parent_folder_id
      ? _getFolderById({ project, folderId: updatedFolder.parent_folder_id })
      : Promise.resolve(null),
  ]);

  // ZL-18798: tab routing via level_1 sub-unit. For nested folder updates,
  // the parent folder's owner gets My Drive (their folder, their subfolder).
  // For root folder updates, the folder's own created_by is the relevant
  // owner (no parent to inherit from).
  const updateOwnerId = parentFolderForUpdate
    ? parentFolderForUpdate.created_by
    : updatedFolder.created_by;

  // ZL-20178: repeated edits must not STACK edit badges on receivers (the
  // folders-section count climbed to N for a single edited folder). Only fire a
  // fresh drive_folder_updated to receivers who do NOT already hold an unread
  // one for THIS folder — a receiver who still has an unread edit badge keeps it
  // (count stays 1); one with none (first edit, or who already read the prior
  // badge) gets a fresh one.
  //
  // NOTE: an earlier version silent-marked the prior badge + re-saved a fresh
  // one, but that relied on clients honoring the notification:silent drop —
  // web/iOS/Android don't reliably evict on silent, so they kept stacking. This
  // skip-if-already-unread approach (mirrors the share flow's dedup) coalesces
  // to a single edit badge WITHOUT depending on client silent handling. Best-
  // effort: on any lookup error fall back to notifying everyone.
  let updateReceiverIds = folderUpdateReceiverIds;
  if (folderUpdateReceiverIds.length > 0) {
    try {
      const alreadyUnread = await NotificationRepository.getNotifications({
        filters: {
          project_id: project._id,
          receiver: { $in: folderUpdateReceiverIds },
          reference_id: toIdString(updatedFolder._id),
          action: 'drive_folder_updated',
          message_read: false,
        },
      });
      const alreadyBadged = new Set(alreadyUnread.map((n) => toIdString(n.receiver)));
      updateReceiverIds = folderUpdateReceiverIds.filter(
        (id) => !alreadyBadged.has(toIdString(id)),
      );
    } catch (err) {
      console.error('[updateFolder_dedup_failed]:', err.message);
    }
  }

  if (updateReceiverIds.length > 0) {
    await DriveNotificationReceivers.notifyAllTabRouted({
      project,
      actor: user,
      receiverIds: updateReceiverIds,
      parentFolderOwnerId: updateOwnerId,
      folderId: updatedFolder.parent_folder_id,
      itemId: updatedFolder._id,
      unit: DRIVE_UNIT_FOLDER,
      action: 'drive_folder_updated',
      message: `Folder "${updatedFolder.folder_name}" updated`,
      referenceData: {
        folder_id: toIdString(updatedFolder._id),
        folder_name: updatedFolder.folder_name,
        parent_folder_id: updatedFolder.parent_folder_id ? toIdString(updatedFolder.parent_folder_id) : null,
      },
      socketClient,
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

  // ZL-19058: capture file _ids before soft-delete so we can mark prior
  // unread notifications referencing those files (and the folders) as
  // read after the delete completes. Replaces the previous countFiles()
  // call — getFiles returns full docs so we have both the count
  // (filesToDeleteDocs.length) and the _ids needed for the notification
  // cleanup pass below.
  const filesToDeleteDocs = await DriveFileRepository.getFiles({
    filters: {
      project_id: project._id,
      folder_id: { $in: folderIds },
      deleted_on: 0,
    },
  });
  const filesToDelete = filesToDeleteDocs.length;

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

  // ZL-19058: silent-mark unread bell rows that reference any deleted
  // folder OR any file inside (recursive — folderIds already contains
  // root + all descendants from collectDescendantFolderIds). Same
  // pattern as deleteFile + driveFileAccess.js share-revoke flow.
  // Wrapped in try/catch — the delete itself already succeeded.
  try {
    const allDeletedItemIds = [
      ...folderIds.map((id) => toIdString(id)),
      ...filesToDeleteDocs.map((f) => toIdString(f._id)),
    ];

    const staleFilters = {
      project_id: project._id,
      reference_id: { $in: allDeletedItemIds },
      message_read: false,
    };

    const staleNotifications = await NotificationRepository.getNotifications({
      filters: staleFilters,
    });

    if (staleNotifications.length > 0) {
      await NotificationRepository.updateNotification({
        filters: staleFilters,
        data: { message_read: true, updated: Date.now() },
      });

      // Group prior uuids per receiver — each FE drops its own badges
      // from BadgeDB by primary key (notification_uuid).
      const byReceiver = new Map();
      staleNotifications.forEach((n) => {
        const rid = toIdString(n.receiver);
        if (!byReceiver.has(rid)) byReceiver.set(rid, []);
        byReceiver.get(rid).push(n.notification_uuid);
      });

      await Promise.all(
        Array.from(byReceiver.entries()).map(([receiverId, uuids]) =>
          DriveNotificationReceivers.notifyAllTabRouted({
            project,
            actor: user,
            receiverIds: [receiverId],
            parentFolderOwnerId: null, // silent drop — tab doesn't matter, FE keys by uuid
            folderId: folder.parent_folder_id,
            itemId: folder._id,
            unit: DRIVE_UNIT_FOLDER,
            action: 'drive_folder_deleted',
            referenceData: {
              folder_id: toIdString(folder._id),
              folder_name: folder.folder_name,
              read_notification_ids: uuids.filter(Boolean),
            },
            socketClient,
            options: { save: false, silent: true },
          })
        )
      );
    }
  } catch (err) {
    console.error('[deleteFolder] silent-mark stale notifications failed:', err.message);
  }

  const [folderDeleteReceiverIds, parentFolderForDelete] = await Promise.all([
    DriveNotificationReceivers.getFolderReceivers({
      project,
      actorId: user._id,
      folderId: folder._id,
    }),
    folder.parent_folder_id
      ? _getFolderById({ project, folderId: folder.parent_folder_id })
      : Promise.resolve(null),
  ]);

  // ZL-18798: tab routing — parent folder owner sees this delete in My Drive
  // (their folder lost a child); root folder fallback uses folder.created_by.
  const deleteOwnerId = parentFolderForDelete
    ? parentFolderForDelete.created_by
    : folder.created_by;
  await DriveNotificationReceivers.notifyAllTabRouted({
    project,
    actor: user,
    receiverIds: folderDeleteReceiverIds,
    parentFolderOwnerId: deleteOwnerId,
    folderId: folder.parent_folder_id,
    itemId: folder._id,
    unit: DRIVE_UNIT_FOLDER,
    action: 'drive_folder_deleted',
    message: `Folder "${folder.folder_name}" deleted`,
    referenceData: {
      folder_id: toIdString(folder._id),
      folder_name: folder.folder_name,
      parent_folder_id: folder.parent_folder_id ? toIdString(folder.parent_folder_id) : null,
    },
    socketClient,
  });

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
  });

  const files = await DriveFileRepository.getFiles({
    filters: {
      folder_id: folder._id,
      project_id: project._id,
      deleted_on: 0,
    },
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

  // 7. Resolve a non-colliding name in the target — never block the move.
  // Auto-suffix " (N)" within the user's own namespace (Private Drive,
  // ZL-18867). Excludes the folder being moved. resolvedName ===
  // folder.folder_name when the target had no collision.
  const resolvedName = await DriveNameResolver.resolveAvailableFolderName({
    folderName: folder.folder_name,
    projectId: project._id,
    parentFolderId: target_folder_id,
    createdBy: user._id,
    excludeId: folderId,
  });

  // 8. Update the folder's parent.
  // MUST use updateFolderDocument (findOneAndUpdate {new:true}) — NOT
  // updateFolder (updateOne), which returns a Mongoose write-result
  // ({acknowledged, matchedCount, modifiedCount, ...}) rather than the
  // folder doc. With a write-result, updatedFolder._id /
  // .parent_folder_id / .folder_name / .created_by are all undefined,
  // which silently no-ops every downstream step: _refreshDescendantPaths,
  // getFolderReceivers (folderId=undefined → []), the silent-drop
  // (reference_id=null → matches nothing), the fresh drive_folder_moved
  // save (itemId=undefined → junk level_1='root'/reference_id=null), and
  // the subtree re-anchor (rootFolderId=undefined). Net effect (ZL-18871):
  // the DB move succeeds but NO badge notifications fire, so socket-only
  // clients (iOS) never re-anchor the moved folder's badge. Web masked it
  // by re-fetching on the drive:folder:moved socket. Mirrors the
  // updateFolder *service* which already uses updateFolderDocument.
  const updatedFolder = await DriveFolderRepository.updateFolderDocument({
    filters: { _id: folderId, project_id: project._id, deleted_on: 0 },
    data: {
      parent_folder_id: target_folder_id || null,
      // Only write folder_name when the auto-suffix actually changed it.
      ...(resolvedName !== folder.folder_name ? { folder_name: resolvedName } : {}),
      updated_by: user._id,
      updated_on: Date.now(),
    },
  });

  if (!updatedFolder) {
    throw new BadRequest('folder_update_failed');
  }

  // 9. Refresh descendant folder paths
  await _refreshDescendantPaths({ project, rootFolder: updatedFolder, user });

  // 9.5 Reconcile inherited access records from the new parent.
  // ZL-20162: skipAccessCheck — the move already authorized the actor (editor
  // on the target); inheritFolderAccessToDescendants is otherwise owner-gated
  // (it doubles as a standalone owner-only endpoint), which re-blocked an
  // editor's valid move AFTER the parent mutation, so the move persisted then
  // 403'd. Also wrapped best-effort like the notify/re-anchor blocks below —
  // the move already succeeded, so a reconcile hiccup must not fail the request.
  if (target_folder_id) {
    try {
      const targetFolder = await DriveFolderRepository.getFolder({
        filters: { _id: target_folder_id, project_id: project._id, deleted_on: 0 },
      });
      if (targetFolder) {
        await DriveAccessService.inheritFolderAccessToDescendants({
          user, project, folder: targetFolder, skipAccessCheck: true,
        });
      }
    } catch (err) {
      console.error('[moveFolder_inherit_failed]:', err.message);
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
    const moveReceiverIds = await DriveNotificationReceivers.getMoveReceivers({
      project,
      actorId: user._id,
      sourceFolderId,
      targetFolderId: movedTargetFolderId,
    });

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
      // ZL-18798: tab routing — for moved folder, the relevant owner is the
      // TARGET parent's owner (move lands the folder under the new parent).
      // For root-level target, fall back to updatedFolder.created_by.
      const targetParent = updatedFolder.parent_folder_id
        ? await _getFolderById({ project, folderId: updatedFolder.parent_folder_id })
        : null;
      // ZL-18885: route BOTH the moved folder's OWNER and the target folder's
      // owner to My Drive (the moved folder belongs to its owner's drive; the
      // target belongs to its owner's). Previously only the target parent's
      // owner got My Drive, so the moved folder's owner (e.g. User A whose
      // shared folder was moved by an all-rights sharee) wrongly landed in
      // Shared With Me. Array is de-duped/filtered in splitReceiversByOwnership.
      const movedOwnerId = [
        toIdString(updatedFolder.created_by),
        targetParent ? toIdString(targetParent.created_by) : null,
      ].filter(Boolean);

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

        await DriveNotificationReceivers.notifyAllTabRouted({
          project,
          actor: user,
          receiverIds: allReceiverIds,
          parentFolderOwnerId: movedOwnerId,
          folderId: updatedFolder.parent_folder_id || updatedFolder._id,
          itemId: updatedFolder._id,
          unit: DRIVE_UNIT_FOLDER,
          action: 'drive_folder_moved',
          referenceData: {
            folder_id: toIdString(updatedFolder._id),
            folder_name: updatedFolder.folder_name,
            source_parent_id: sourceFolderId,
            target_parent_id: movedTargetFolderId,
            read_notification_ids: priorReadIds.filter(Boolean),
          },
          socketClient,
          options: { save: false, silent: true },
        });
      }

      await DriveNotificationReceivers.notifyAllTabRouted({
        project,
        actor: user,
        receiverIds: allReceiverIds,
        parentFolderOwnerId: movedOwnerId,
        folderId: updatedFolder.parent_folder_id || updatedFolder._id,
        itemId: updatedFolder._id,
        unit: DRIVE_UNIT_FOLDER,
        action: 'drive_folder_moved',
        message: `Folder "${updatedFolder.folder_name}" moved`,
        referenceData: {
          folder_id: toIdString(updatedFolder._id),
          folder_name: updatedFolder.folder_name,
          source_parent_id: sourceFolderId,
          target_parent_id: movedTargetFolderId,
        },
        socketClient,
      });
    }
  } catch (err) {
    // Notification path is non-fatal — the move itself already succeeded.
    console.error('[moveFolder_notify_failed]:', err.message);
  }

  // ZL-18871/-18872: re-anchor every unread badge in the MOVED SUBTREE
  // — descendant folders + the files inside them — so they roll up under
  // the new ancestor.
  //
  // Why a three-phase flow (mark-read → silent-drop → fresh-save) instead
  // of an in-place level_* rewrite:
  //   Clients that work purely off socket events (iOS in particular) maintain
  //   their badge list from notification:save (add) and notification:silent
  //   (drop) events alone — they do NOT issue a /notifications GET after a
  //   silent event. So an in-place DB rewrite of level_1..3 is invisible to
  //   iOS: the badge keeps its pre-move levels in the local store and rolls
  //   up under the OLD ancestor forever, until the app cold-starts.
  //
  // Three-phase flow mirrors what the moved-folder OWN block does at
  // 1691-1747 — the canonical share/move pattern in this codebase:
  //   1) MARK READ in DB the original unread subtree notifications, so they
  //      no longer count toward badges anywhere (cold-fetch or otherwise).
  //   2) SILENT DROP per receiver — emit notification:silent carrying
  //      read_notification_ids = [original uuids]; each client evicts those
  //      uuids from its local badge cache.
  //   3) FRESH SAVE per (item, receiver) — emit notification:save with
  //      action drive_folder_subtree_reanchored and a NEW level chain
  //      computed from the moved folder's new path. notify:false suppresses
  //      FCM push so the user's device doesn't get one phone push per
  //      descendant (the user already got a single Folder moved push from
  //      the block above); save:true persists the new notification in DB
  //      so cold-fetch is also correct.
  //
  // Cost: O(items × receivers) save events, but all marked silent at the
  // FCM layer (notify:false). For a deep subtree this is a burst of socket
  // messages — acceptable, since it only fires once per folder move.
  try {
    const subtreeFolderIds = await DriveAccessService.collectDescendantFolderIds({
      projectId: project._id,
      rootFolderId: updatedFolder._id,
      includeRoot: true,
    });
    const subtreeFiles = await DriveFileRepository.getFiles({
      filters: {
        project_id: project._id,
        folder_id: { $in: subtreeFolderIds },
        deleted_on: 0,
      },
    });

    // Aggregate every reference_id we want to re-anchor. Excludes the moved
    // folder's OWN id — its badge is handled by the silent-drop + fresh save
    // block above (1691-1747).
    const allSubtreeRefIds = [
      ...subtreeFolderIds
        .filter((sId) => !idsEqual(sId, updatedFolder._id))
        .map(toIdString),
      ...subtreeFiles.map((f) => toIdString(f._id)),
    ].filter(Boolean);

    // Capture prior unread notifications BEFORE we mark them read. We need
    // their notification_uuid (for silent-drop), receiver (for fan-out), and
    // unit (to emit the matching fresh save with the right resource kind).
    const priorSubtreeNotifications = allSubtreeRefIds.length > 0
      ? await NotificationRepository.getNotifications({
        filters: {
          project_id: project._id,
          reference_id: { $in: allSubtreeRefIds },
          message_read: false,
        },
      })
      : [];

    if (priorSubtreeNotifications.length > 0) {
      // Phase 1 — mark originals as read so they no longer drive badges.
      // The fresh-save phase creates replacement notifications with the
      // correct level chain; without the mark-read, cold-fetch clients
      // would see duplicate badges.
      await NotificationRepository.updateNotification({
        filters: {
          project_id: project._id,
          reference_id: { $in: allSubtreeRefIds },
          message_read: false,
        },
        data: { message_read: true, updated: Date.now() },
      });

      // Phase 2 — silent drop per receiver so each client evicts the
      // pre-move uuids from its local badge cache. action label is
      // backend-internal — FE silent handler keys off
      // notification:silent + read_notification_ids, not the action name.
      // The target parent's owner is the tab-routing anchor for the whole
      // moved subtree (matches the moved-folder OWN block above).
      const targetParent = updatedFolder.parent_folder_id
        ? await _getFolderById({ project, folderId: updatedFolder.parent_folder_id })
        : null;
      // ZL-18885: same as the moved-folder OWN block — route both the moved
      // subtree's owner and the target folder's owner to My Drive.
      const subtreeOwnerId = [
        toIdString(updatedFolder.created_by),
        targetParent ? toIdString(targetParent.created_by) : null,
      ].filter(Boolean);

      const dropByReceiver = new Map();
      priorSubtreeNotifications.forEach((n) => {
        const rid = toIdString(n.receiver);
        if (!dropByReceiver.has(rid)) dropByReceiver.set(rid, []);
        dropByReceiver.get(rid).push(n.notification_uuid);
      });

      await Promise.all(
        Array.from(dropByReceiver.entries()).map(([receiverId, uuids]) =>
          DriveNotificationReceivers.notifyAllTabRouted({
            project,
            actor: user,
            receiverIds: [receiverId],
            parentFolderOwnerId: subtreeOwnerId,
            folderId: updatedFolder.parent_folder_id || updatedFolder._id,
            itemId: updatedFolder._id,
            unit: DRIVE_UNIT_FOLDER,
            action: 'drive_folder_subtree_reanchored',
            referenceData: {
              folder_id: toIdString(updatedFolder._id),
              folder_name: updatedFolder.folder_name,
              source_parent_id: folder.parent_folder_id
                ? toIdString(folder.parent_folder_id)
                : null,
              target_parent_id: target_folder_id || null,
              read_notification_ids: uuids.filter(Boolean),
            },
            socketClient,
            options: { save: false, silent: true },
          })
        )
      );

      // Phase 3 — fan out fresh notification:save per (item, receiver) with
      // the new level chain. Each save is FCM-suppressed (notify:false) so
      // there's no phone push per item — the user already got a single
      // Folder moved push from the block above. save:true persists each new
      // notification in DB so the badge survives a cold fetch.
      //
      // We compute the chain ONCE per subtree folder (it's the folder's
      // ancestry; same for a folder and every file directly inside it,
      // only itemId / reference_id differs).
      const priorByRefId = new Map();
      priorSubtreeNotifications.forEach((n) => {
        const ref = toIdString(n.reference_id);
        if (!priorByRefId.has(ref)) priorByRefId.set(ref, []);
        priorByRefId.get(ref).push(n);
      });

      await Promise.all(subtreeFolderIds.map(async (sId) => {
        const folderSelfPriors = priorByRefId.get(toIdString(sId)) || [];
        const filesInThisFolder = subtreeFiles.filter((f) => idsEqual(f.folder_id, sId));

        const emits = [];

        // Folder sId itself — skip the moved root (handled by the
        // moved-folder OWN block above).
        if (!idsEqual(sId, updatedFolder._id) && folderSelfPriors.length > 0) {
          const folderReceivers = Array.from(new Set(
            folderSelfPriors.map((n) => toIdString(n.receiver))
          )).filter(Boolean);

          if (folderReceivers.length > 0) {
            emits.push(DriveNotificationReceivers.notifyAllTabRouted({
              project,
              actor: user,
              receiverIds: folderReceivers,
              parentFolderOwnerId: subtreeOwnerId,
              folderId: sId,
              itemId: sId,
              unit: DRIVE_UNIT_FOLDER,
              action: 'drive_folder_subtree_reanchored',
              referenceData: {
                folder_id: toIdString(updatedFolder._id),
                folder_name: updatedFolder.folder_name,
                source_parent_id: folder.parent_folder_id
                  ? toIdString(folder.parent_folder_id)
                  : null,
                target_parent_id: target_folder_id || null,
                descendant_folder_id: toIdString(sId),
              },
              socketClient,
              // notify:false → no FCM push (already sent for the move root).
              // save:true → persist new notification in DB + emit
              //             notification:save so clients add the badge.
              options: { notify: false, save: true },
            }));
          }
        }

        // Each file directly inside sId.
        for (const file of filesInThisFolder) {
          const filePriors = priorByRefId.get(toIdString(file._id)) || [];
          if (filePriors.length === 0) continue;

          const fileReceivers = Array.from(new Set(
            filePriors.map((n) => toIdString(n.receiver))
          )).filter(Boolean);

          if (fileReceivers.length > 0) {
            emits.push(DriveNotificationReceivers.notifyAllTabRouted({
              project,
              actor: user,
              receiverIds: fileReceivers,
              parentFolderOwnerId: subtreeOwnerId,
              // folderId is the file's parent; drives the level chain.
              folderId: sId,
              itemId: file._id,
              unit: DRIVE_UNIT_FILE,
              action: 'drive_folder_subtree_reanchored',
              referenceData: {
                folder_id: toIdString(updatedFolder._id),
                folder_name: updatedFolder.folder_name,
                source_parent_id: folder.parent_folder_id
                  ? toIdString(folder.parent_folder_id)
                  : null,
                target_parent_id: target_folder_id || null,
                file_id: toIdString(file._id),
                file_name: file.file_name,
                parent_folder_id: toIdString(sId),
              },
              socketClient,
              options: { notify: false, save: true },
            }));
          }
        }

        if (emits.length > 0) await Promise.all(emits);
      }));
    }
  } catch (err) {
    // Non-fatal — the move + folder-level notification already succeeded.
    console.error('[moveFolder_subtree_reanchor_failed]:', err.message);
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
