import { GetObjectCommand } from '@aws-sdk/client-s3';
import BadRequest from 'zillit-libs/errors/BadRequest';
import Forbidden from 'zillit-libs/errors/Forbidden';

import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFileVersionRepository from '../../repositories/v2/driveFileVersion.js';
import DriveActivityService from './driveActivity.js';
import DriveVersionStore from './driveVersionStore.js';
import DriveVersionDiffQueue from './driveVersionDiffQueue.js';
import DriveEditPresenceService from './driveEditPresence.js';
import DriveSheetView from './driveSheetView.js';
import socketClient from '../../config/socketClient.js';
import { signAccessToken, verifyAccessToken, getAccessTokenTTL } from '../../utils/editorJwt.js';
import { getS3Client, getFileS3Info, getObjectBuffer } from '../../utils/driveS3.js';

/**
 * The file host side of the document editor (WOPI). Collabora calls these
 * endpoints to read a file's details, fetch its content and save it back.
 *
 * A file id of the form "<fileId>_v<versionId>" addresses one earlier
 * version, read-only. It is a different document to the editor, so a
 * version preview never joins the live editing session.
 */

/* ───────────── Errors ───────────── */

// The file changed since the editor loaded it (someone restored a version,
// or uploaded over it). The route answers 409 with COOLStatusCode 1010 and
// the editor asks the user whether to overwrite or reload.
class WopiConflict extends Error {
  constructor(message = 'document_changed_in_storage') {
    super(message);
    this.statusCode = 409;
    this.wopiConflict = true;
  }
}

/* ───────────── WOPI Access Token ───────────── */

/**
 * Generate a WOPI access token for a user + file combination.
 * The token encodes userId, projectId, fileId, and permissions.
 */
const generateAccessToken = ({ user, project, file, canEdit, canDownload }) => {
  const payload = {
    type: 'wopi_access',
    userId: user._id.toString(),
    projectId: project._id.toString(),
    fileId: file._id.toString(),
    userName: user.full_name || user.name || user.email || 'User',
    canEdit: !!canEdit,
    canDownload: !!canDownload,
  };
  const token = signAccessToken(payload);
  const ttl = getAccessTokenTTL();
  return { token, ttl };
};

/**
 * A read-only token for one earlier version of a file. The version id is
 * part of the token, so it can't be used against the live file or another
 * version.
 */
const generateVersionAccessToken = ({
  user, project, file, version, canDownload,
}) => {
  const payload = {
    type: 'wopi_access',
    origin: 'version_preview',
    userId: user._id.toString(),
    projectId: project._id.toString(),
    fileId: file._id.toString(),
    versionId: version._id.toString(),
    userName: user.full_name || user.name || user.email || 'User',
    canEdit: false,
    canDownload: !!canDownload,
  };
  const token = signAccessToken(payload);
  const ttl = getAccessTokenTTL();
  return { token, ttl };
};

/**
 * Generate a WOPI access token for a PUBLIC share-link recipient — i.e.
 * someone viewing the file through /share/:token without a Zillit account.
 *
 * Same shape as `generateAccessToken` but:
 *   - `userId` carries the recipient_token (unique per share-link recipient)
 *   - `userName` is the recipient's email
 *   - `canEdit` is force-false (PutFile already rejects on !canEdit)
 *   - `canDownload` is force-false (anti-leak)
 *   - `linkId` is embedded so revoke / expiry checks can be reproduced
 *
 * The token type remains 'wopi_access' so the existing CheckFileInfo /
 * GetFile endpoints accept it without changes — they only validate
 * the signature, type, and fileId match.
 */
const generatePublicShareAccessToken = ({
  link, recipient, project, file,
}) => {
  const payload = {
    type: 'wopi_access',
    // Mark the origin so audit/grep can tell apart user vs share-link sessions.
    origin: 'public_share_link',
    userId: recipient?.recipient_token || link._id.toString(),
    projectId: project._id.toString(),
    fileId: file._id.toString(),
    userName: recipient?.email || 'Share Recipient',
    canEdit: false,
    canDownload: false,
    linkId: link._id.toString(),
  };
  const token = signAccessToken(payload);
  const ttl = getAccessTokenTTL();
  return { token, ttl };
};

/**
 * Verify a WOPI access token and return the decoded payload.
 */
const verifyWopiToken = (token) => {
  if (!token) throw new Forbidden('missing_access_token');
  const payload = verifyAccessToken(token);
  if (payload.type !== 'wopi_access') throw new Forbidden('invalid_token_type');
  return payload;
};

/* ───────────── Helpers ───────────── */

// "<fileId>" or "<fileId>_v<versionId>"
const parseWopiFileId = (raw) => {
  const [fileId, versionId] = String(raw || '').split('_v');
  return { fileId, versionId: versionId || null };
};

// The token must be for exactly this document: the same file, and the same
// version (or none, for the live file).
const authorize = ({ params, query }) => {
  const { fileId, versionId } = parseWopiFileId(params.fileId);
  const tokenPayload = verifyWopiToken(query.access_token);
  if (tokenPayload.fileId !== fileId || (tokenPayload.versionId || null) !== versionId) {
    throw new Forbidden('token_file_mismatch');
  }
  return { fileId, versionId, tokenPayload };
};

const loadFile = async ({ fileId, tokenPayload }) => {
  const file = await DriveFileRepository.getFile({
    filters: { _id: fileId, project_id: tokenPayload.projectId, deleted_on: 0 },
  });
  if (!file) throw new BadRequest('file_not_found');
  return file;
};

const loadVersion = async ({ file, versionId, tokenPayload }) => {
  const version = await DriveFileVersionRepository.getVersion({
    filters: { _id: versionId, file_id: file._id, project_id: tokenPayload.projectId },
  });
  if (!version) throw new BadRequest('version_not_found');
  return version;
};

// When the file's content last changed. Renames and moves don't count.
const contentTimeOf = (file) => file.content_updated_on || file.created_on || 0;

const isoTime = (ms) => new Date(ms || 0).toISOString();

// "Budget.xlsx" -> "Budget (version 12).xlsx"
const versionFileName = (fileName, number) => {
  const name = String(fileName || 'Document');
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name} (version ${number})`;
  return `${name.slice(0, dot)} (version ${number})${name.slice(dot)}`;
};

const saveTypeFrom = (req) => {
  const header = (name) => String(req.get(`X-COOL-WOPI-${name}`) || req.get(`X-LOOL-WOPI-${name}`) || '').toLowerCase();
  if (header('IsExitSave') === 'true') return 'exit';
  if (header('IsAutosave') === 'true') return 'autosave';
  return 'manual';
};

const modifiedByUserFrom = (req) => {
  const value = String(req.get('X-COOL-WOPI-IsModifiedByUser') || req.get('X-LOOL-WOPI-IsModifiedByUser') || '').toLowerCase();
  return value !== 'false';
};

const timestampFrom = (req) => req.get('X-COOL-WOPI-Timestamp') || req.get('X-LOOL-WOPI-Timestamp') || null;

/* ───────────── WOPI CheckFileInfo ───────────── */

/**
 * WOPI CheckFileInfo endpoint.
 * Collabora calls this to get file metadata and user permissions.
 * https://docs.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/rest/files/checkfileinfo
 */
const checkFileInfo = async ({ params, query }) => {
  const { fileId, versionId, tokenPayload } = authorize({ params, query });
  const file = await loadFile({ fileId, tokenPayload });

  const common = {
    OwnerId: (file.created_by || '').toString(),
    UserId: tokenPayload.userId,
    UserFriendlyName: tokenPayload.userName,
    UserCanNotWriteRelative: true,
    PostMessageOrigin: '*',
    EnableInsertRemoteImage: false,
    DisablePrint: !tokenPayload.canDownload,
    DisableExport: !tokenPayload.canDownload,
    DisableCopy: false,
    HideExportOption: !tokenPayload.canDownload,
    HidePrintOption: !tokenPayload.canDownload,
  };

  if (versionId) {
    const version = await loadVersion({ file, versionId, tokenPayload });
    return {
      ...common,
      BaseFileName: versionFileName(file.file_name, version.version_number),
      Size: version.file_size_bytes || 0,
      LastModifiedTime: isoTime(version.saved_at || version.created_on),
      UserCanWrite: false,
      ReadOnly: true,
      HideSaveOption: true,
    };
  }

  // Someone opened (or re-opened) the file in the editor.
  if (tokenPayload.origin !== 'public_share_link') {
    DriveEditPresenceService.touch({
      projectId: tokenPayload.projectId,
      fileId: file._id,
      userId: tokenPayload.userId,
      canEdit: !!tokenPayload.canEdit,
      state: 'seen',
    }).catch((error) => console.error('[wopi_presence_failed]:', error.message));
  }

  return {
    ...common,
    BaseFileName: file.file_name,
    Size: file.file_size_bytes || 0,
    // Collabora sends this back with each save; if the file changed in
    // between, the save is refused instead of silently overwriting.
    LastModifiedTime: isoTime(contentTimeOf(file)),
    UserCanWrite: tokenPayload.canEdit,
    HideSaveOption: !tokenPayload.canEdit,
  };
};

/* ───────────── WOPI GetFile ───────────── */

/**
 * WOPI GetFile endpoint.
 * Collabora calls this to download the file contents for editing.
 * Streams the file from S3.
 */
const getFileContents = async ({ params, query, res }) => {
  const { fileId, versionId, tokenPayload } = authorize({ params, query });
  const file = await loadFile({ fileId, tokenPayload });

  let source;
  let sizeBytes = file.file_size_bytes;
  if (versionId) {
    const version = await loadVersion({ file, versionId, tokenPayload });
    source = { s3Key: version.s3_key, bucket: version.s3_bucket, region: version.s3_region };
    sizeBytes = version.file_size_bytes;
  } else {
    source = getFileS3Info(file);
  }
  if (!source.s3Key) throw new BadRequest('file_has_no_storage_path');

  // Read-only opens can't be moved to A1 from the page, so the copy they
  // get has the last saver's cursor and scroll position removed.
  const readOnly = !!versionId || !tokenPayload.canEdit;
  const extension = DriveVersionStore.extensionOf(file);
  if (readOnly && DriveSheetView.canReset({ extension, sizeBytes })) {
    const original = await getObjectBuffer({ bucket: source.bucket, key: source.s3Key, region: source.region });
    const body = DriveSheetView.resetSavedPosition(original);
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', body.length);
    res.end(body);
    return null;
  }

  const s3Response = await getS3Client(source.region).send(new GetObjectCommand({
    Bucket: source.bucket,
    Key: source.s3Key,
  }));

  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  if (s3Response.ContentLength) {
    res.setHeader('Content-Length', s3Response.ContentLength);
  }

  s3Response.Body.pipe(res);
  return null; // response already handled
};

/* ───────────── WOPI PutFile ───────────── */

/**
 * WOPI PutFile endpoint. Collabora calls this to save the edited file.
 *
 * Each save becomes a version labelled with the saver, the save type and
 * everyone editing since the last version. Saves the user didn't make
 * (the re-save after opening a large spreadsheet) and byte-identical saves
 * are acknowledged without writing anything.
 */
const putFileContents = async ({ params, query, req }) => {
  const { fileId, versionId, tokenPayload } = authorize({ params, query });

  if (versionId || !tokenPayload.canEdit) {
    throw new Forbidden('no_edit_permission');
  }

  const file = await loadFile({ fileId, tokenPayload });

  // Refuse to overwrite content that changed since this editor loaded it.
  // Collabora leaves the header out when the user chose to overwrite.
  const loadedAt = timestampFrom(req);
  if (loadedAt) {
    const loadedMs = new Date(loadedAt).getTime();
    if (Number.isFinite(loadedMs) && loadedMs !== contentTimeOf(file)) {
      throw new WopiConflict();
    }
  }

  const buffer = req.body;
  if (!Buffer.isBuffer(buffer)) throw new BadRequest('file_body_missing');

  const result = await DriveVersionStore.recordEditorSave({
    file,
    projectId: tokenPayload.projectId,
    userId: tokenPayload.userId,
    buffer,
    saveType: saveTypeFrom(req),
    modifiedByUser: modifiedByUserFrom(req),
  });

  if (result.skipped) {
    console.log(`[wopi_putfile] Not saved (${result.skipped}): ${file.file_name}`);
    return { status: 'ok', LastModifiedTime: isoTime(contentTimeOf(file)) };
  }

  const { version, savedAt } = result;
  DriveVersionDiffQueue.kick();

  // Real-time refresh for the file list and any open history panel
  socketClient('__admin_events__', {
    event: 'drive:file:updated',
    room: `${tokenPayload.projectId}_room`,
    data: {
      project_id: tokenPayload.projectId,
      file_id: file._id,
      action: 'editor_save',
      version_id: version._id,
    },
  });
  socketClient('__admin_events__', {
    event: 'drive:version:created',
    room: `${tokenPayload.projectId}_room`,
    data: {
      project_id: tokenPayload.projectId,
      file_id: file._id,
      version_id: version._id,
      version_number: version.version_number,
      saved_by: tokenPayload.userId,
      save_type: version.save_type,
    },
  });

  // Log activity (fire-and-forget)
  DriveActivityService.log({
    projectId: tokenPayload.projectId,
    userId: tokenPayload.userId,
    action: 'file_updated',
    itemId: file._id,
    itemType: 'file',
    itemName: file.file_name,
    details: { source: 'collabora', version_number: version.version_number },
  });

  console.log(`[wopi_putfile] File saved: ${file.file_name} v${version.version_number} (${buffer.length} bytes, ${version.save_type})`);

  return { status: 'ok', LastModifiedTime: isoTime(savedAt) };
};

export {
  WopiConflict,
  parseWopiFileId,
  versionFileName,
};

export default {
  generateAccessToken,
  generateVersionAccessToken,
  generatePublicShareAccessToken,
  verifyWopiToken,
  checkFileInfo,
  getFileContents,
  putFileContents,
};
