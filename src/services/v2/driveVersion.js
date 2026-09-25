import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import BadRequest from 'zillit-libs/errors/BadRequest';

import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFileVersionRepository from '../../repositories/v2/driveFileVersion.js';
import DriveFileVersionChangeRepository from '../../repositories/v2/driveFileVersionChange.js';
import DriveFileAccessService from './driveFileAccess.js';
import DriveActivityService from './driveActivity.js';
import DriveVersionStore from './driveVersionStore.js';
import DriveVersionDiffQueue from './driveVersionDiffQueue.js';
import DriveWopiService from './driveWopi.js';
import { WOPI_BASE_URL, COLLABORA_URL, getCollaboraEditorUrl } from './driveEditor.js';
import socketClient from '../../config/socketClient.js';
import { getS3Client, S3_DEFAULT_REGION } from '../../utils/driveS3.js';

/**
 * DriveVersionService — version history of a Drive file, as the web and
 * mobile clients see it.
 */

const HISTORY_LIMIT = 300;
const NAME_MAX = 80;

const idOf = (value) => (value ? String(value._id || value) : null);

// Every version endpoint checks the caller's access to the file itself,
// not only to Drive: versions of a file you can't see stay hidden.
const loadFile = async ({
  user, project, fileId, permission,
}) => {
  const file = await DriveFileRepository.getFile({
    filters: { _id: fileId, project_id: project._id, deleted_on: 0 },
  });
  if (!file) throw new BadRequest('file_not_found');
  await DriveFileAccessService.assertFileAccess({
    user, project, file, permission,
  });
  return file;
};

const loadVersion = async ({ project, file, versionId }) => {
  const version = await DriveFileVersionRepository.getVersion({
    filters: { _id: versionId, project_id: project._id, file_id: file._id },
  });
  if (!version) throw new BadRequest('version_not_found');
  return version;
};

/**
 * What a client shows for a version.
 *
 * Legacy records are snapshots of the content before a save, labelled with
 * whoever made that save. The person and time that actually produced the
 * content belong to the record before (or, for the first, the upload), so
 * shift them by one.
 */
const presentVersions = (records, file) => {
  const ascending = [...records].sort((a, b) => a.version_number - b.version_number);
  let previousLegacy = null;

  return ascending.map((record) => {
    const legacy = !record.saved_by;
    let savedBy;
    let savedAt;
    if (legacy) {
      savedBy = previousLegacy ? previousLegacy.uploaded_by : (file.uploaded_by || file.created_by);
      savedAt = previousLegacy ? previousLegacy.created_on : file.created_on;
      previousLegacy = record;
    } else {
      savedBy = record.saved_by;
      savedAt = record.saved_at;
    }

    return {
      _id: record._id,
      version_number: record.version_number,
      name: record.name || '',
      file_name: record.file_name,
      file_size_bytes: record.file_size_bytes || 0,
      mime_type: record.mime_type || '',
      saved_by: idOf(savedBy),
      saved_at: savedAt || record.created_on,
      save_type: legacy ? 'legacy' : record.save_type,
      editors: legacy
        ? [idOf(savedBy)].filter(Boolean)
        : (record.editors || []).map(idOf),
      session_id: legacy ? '' : (record.session_id || ''),
      restored_from: idOf(record.restored_from),
      is_current: idOf(file.current_version_id) === idOf(record._id),
      legacy,
      changes: {
        status: record.changes?.status || 'none',
        cells: record.changes?.cells || 0,
        sheets: record.changes?.sheets || 0,
        truncated: !!record.changes?.truncated,
        reason: record.changes?.reason || '',
      },
      // Unchanged fields, for clients built against the old shape.
      uploaded_by: idOf(record.uploaded_by),
      created_on: record.created_on,
    };
  });
};

/**
 * The file's live content when it isn't a version record yet (a file never
 * saved from the editor, or one whose history is all legacy snapshots).
 */
const currentEntryFor = (file, presented) => {
  if (file.current_version_id) return null;
  const newestLegacy = [...presented].reverse().find((v) => v.legacy);
  const savedBy = newestLegacy ? newestLegacy.uploaded_by : idOf(file.uploaded_by || file.created_by);
  const savedAt = newestLegacy ? newestLegacy.created_on : file.created_on;
  return {
    _id: 'current',
    version_number: null,
    name: '',
    file_name: file.file_name,
    file_size_bytes: file.file_size_bytes || 0,
    saved_by: savedBy,
    saved_at: savedAt,
    save_type: newestLegacy ? 'legacy' : 'upload',
    editors: [savedBy].filter(Boolean),
    session_id: '',
    is_current: true,
    legacy: !!newestLegacy,
    synthetic: true,
    changes: {
      status: 'none', cells: 0, sheets: 0, truncated: false, reason: '',
    },
  };
};

// Newest first; consecutive versions of one editing session become a group.
const groupSessions = (entries) => {
  const groups = [];
  entries.forEach((entry) => {
    const last = groups[groups.length - 1];
    if (entry.session_id && last && last.id === entry.session_id) {
      last.versions.push(entry);
      last.started_at = Math.min(last.started_at, entry.saved_at || last.started_at);
      entry.editors.forEach((id) => { if (!last.editors.includes(id)) last.editors.push(id); });
      return;
    }
    groups.push({
      id: entry.session_id || `v-${entry._id}`,
      started_at: entry.saved_at,
      ended_at: entry.saved_at,
      editors: [...entry.editors],
      versions: [entry],
    });
  });
  return groups;
};

/* ───────────── Endpoints ───────────── */

// GET /versions/:fileId: the flat list, newest first (existing clients).
const listVersions = async ({ user, project, params }) => {
  const file = await loadFile({
    user, project, fileId: params.fileId, permission: 'view',
  });
  const records = await DriveFileVersionRepository.getVersions({
    filters: { project_id: project._id, file_id: file._id },
    limit: HISTORY_LIMIT,
  });
  return presentVersions(records, file).reverse();
};

// GET /versions/:fileId/history: grouped for the version history panel.
const getHistory = async ({ user, project, params }) => {
  const file = await loadFile({
    user, project, fileId: params.fileId, permission: 'view',
  });
  const permissions = await DriveFileAccessService.resolveFilePermission({ user, project, file });
  const records = await DriveFileVersionRepository.getVersions({
    filters: { project_id: project._id, file_id: file._id },
    limit: HISTORY_LIMIT,
  });

  const presented = presentVersions(records, file);
  const current = currentEntryFor(file, presented);
  const newestFirst = [...(current ? [current] : []), ...presented.reverse()];

  return {
    file: {
      _id: file._id,
      file_name: file.file_name,
      file_extension: file.file_extension || DriveVersionStore.extensionOf(file),
      current_version_id: idOf(file.current_version_id),
    },
    sessions: groupSessions(newestFirst),
    permissions: {
      can_edit: !!permissions?.can_edit,
      can_download: !!permissions?.can_download,
    },
    truncated: records.length >= HISTORY_LIMIT,
  };
};

// GET /versions/:fileId/:versionId/changes
const getVersionChanges = async ({ user, project, params }) => {
  const file = await loadFile({
    user, project, fileId: params.fileId, permission: 'view',
  });
  const version = await loadVersion({ project, file, versionId: params.versionId });
  const status = version.changes?.status || 'none';
  const base = {
    version_id: version._id,
    status,
    reason: version.changes?.reason || '',
    total: version.changes?.cells || 0,
    truncated: !!version.changes?.truncated,
    sheets: [],
  };
  if (status !== 'done') return base;

  const doc = await DriveFileVersionChangeRepository.getChanges({
    filters: { version_id: version._id },
  });
  if (!doc) return base;
  return {
    ...base,
    base_version_id: doc.base_version_id,
    total: doc.total,
    truncated: doc.truncated,
    sheets: doc.sheets,
  };
};

// PATCH /versions/:fileId/:versionId  { name }
const renameVersion = async ({
  user, project, params, body,
}) => {
  const file = await loadFile({
    user, project, fileId: params.fileId, permission: 'edit',
  });
  const version = await loadVersion({ project, file, versionId: params.versionId });
  const name = String(body?.name || '').trim().slice(0, NAME_MAX);
  await DriveFileVersionRepository.updateVersion({
    filters: { _id: version._id },
    data: { name },
  });
  socketClient('__admin_events__', {
    event: 'drive:version:updated',
    room: `${project._id}_room`,
    data: {
      project_id: project._id, file_id: file._id, version_id: version._id, name,
    },
  });
  return { version_id: version._id, name };
};

// GET /versions/:fileId/:versionId/preview: open a version read-only.
const getVersionPreviewConfig = async ({ user, project, params }) => {
  const file = await loadFile({
    user, project, fileId: params.fileId, permission: 'view',
  });
  const version = await loadVersion({ project, file, versionId: params.versionId });
  if (!version.s3_key) throw new BadRequest('version_has_no_storage_path');

  const permissions = await DriveFileAccessService.resolveFilePermission({ user, project, file });
  const { token: accessToken, ttl: accessTokenTTL } = DriveWopiService.generateVersionAccessToken({
    user, project, file, version, canDownload: !!permissions?.can_download,
  });

  return {
    collaboraUrl: COLLABORA_URL,
    editorUrl: await getCollaboraEditorUrl(),
    // A different document id from the live file, so the preview never
    // joins the live editing session.
    wopiSrc: `${WOPI_BASE_URL}/wopi/files/${file._id}_v${version._id}`,
    accessToken,
    accessTokenTTL,
    fileName: file.file_name,
    fileType: DriveVersionStore.extensionOf(file),
    versionId: version._id,
    versionNumber: version.version_number,
    _permissions: {
      canEdit: false,
      canView: true,
      canDownload: !!permissions?.can_download,
    },
  };
};

// GET /versions/:fileId/:versionId/download
const getVersionDownloadUrl = async ({ user, project, params }) => {
  const file = await loadFile({
    user, project, fileId: params.fileId, permission: 'download',
  });
  const version = await loadVersion({ project, file, versionId: params.versionId });

  const cmd = new GetObjectCommand({
    Bucket: version.s3_bucket,
    Key: version.s3_key,
    ResponseContentDisposition: `attachment; filename="${encodeURIComponent(version.file_name || 'download')}"`,
  });
  const url = await getSignedUrl(getS3Client(version.s3_region || S3_DEFAULT_REGION), cmd, { expiresIn: 3600 });

  return {
    url,
    file_name: version.file_name,
    file_size_bytes: version.file_size_bytes,
    version_number: version.version_number,
  };
};

// POST /versions/:fileId/:versionId/restore
const restoreVersion = async ({ user, project, params }) => {
  const file = await loadFile({
    user, project, fileId: params.fileId, permission: 'edit',
  });
  const version = await loadVersion({ project, file, versionId: params.versionId });

  const { version: restored } = await DriveVersionStore.restoreFromVersion({
    file, projectId: project._id, userId: user._id, version,
  });
  DriveVersionDiffQueue.kick();

  const data = {
    project_id: project._id,
    file_id: file._id,
    version_id: restored._id,
    restored_from: version._id,
    version_number: restored.version_number,
    restored_from_number: version.version_number,
    by: user._id,
  };
  // Open editors reload on this, so nobody saves over the restore.
  socketClient('__admin_events__', { event: 'drive:version:restored', room: `${project._id}_room`, data });
  socketClient('__admin_events__', {
    event: 'drive:file:updated',
    room: `${project._id}_room`,
    data: {
      project_id: project._id, file_id: file._id, action: 'version_restored',
    },
  });

  DriveActivityService.log({
    projectId: project._id,
    userId: user._id,
    action: 'file_updated',
    itemId: file._id,
    itemType: 'file',
    itemName: file.file_name,
    details: { source: 'version_restore', restored_from: version.version_number },
  });

  return {
    message: 'Version restored',
    version_id: restored._id,
    version_number: restored.version_number,
    restored_from: version.version_number,
  };
};

export {
  presentVersions,
  groupSessions,
  currentEntryFor,
};

export default {
  listVersions,
  getHistory,
  getVersionChanges,
  renameVersion,
  getVersionPreviewConfig,
  getVersionDownloadUrl,
  restoreVersion,
};
