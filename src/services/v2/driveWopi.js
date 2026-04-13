import { S3Client, GetObjectCommand, PutObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import BadRequest from 'zillit-libs/errors/BadRequest';
import Forbidden from 'zillit-libs/errors/Forbidden';

import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFileAccessService from './driveFileAccess.js';
import DriveActivityService from './driveActivity.js';
import DriveVersionService from './driveVersion.js';
import socketClient from '../../config/socketClient.js';
import { signAccessToken, verifyAccessToken, getAccessTokenTTL } from '../../utils/editorJwt.js';

/* ───────────── S3 Config ───────────── */

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
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return s3ClientCache[r];
};

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
 * Verify a WOPI access token and return the decoded payload.
 */
const verifyWopiToken = (token) => {
  if (!token) throw new Forbidden('missing_access_token');
  const payload = verifyAccessToken(token);
  if (payload.type !== 'wopi_access') throw new Forbidden('invalid_token_type');
  return payload;
};

/* ───────────── Helper ───────────── */

const getFileS3Info = (file) => {
  const s3Key = file.file_path
    || file.attachments?.[0]?.media
    || file.attachments?.[0]?.file_path;
  const attachment = file.attachments?.[0] || {};
  const bucket = attachment.bucket || S3_BUCKET;
  const region = attachment.region || S3_DEFAULT_REGION;
  return { s3Key, bucket, region };
};

const formatFileSize = (bytes) => {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
};

/* ───────────── WOPI CheckFileInfo ───────────── */

/**
 * WOPI CheckFileInfo endpoint.
 * Collabora calls this to get file metadata and user permissions.
 * https://docs.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/rest/files/checkfileinfo
 */
const checkFileInfo = async ({ params, query }) => {
  const { fileId } = params;
  const tokenPayload = verifyWopiToken(query.access_token);

  if (tokenPayload.fileId !== fileId) {
    throw new Forbidden('token_file_mismatch');
  }

  const file = await DriveFileRepository.getFile({
    filters: { _id: fileId, project_id: tokenPayload.projectId, deleted_on: 0 },
  });

  if (!file) throw new BadRequest('file_not_found');

  return {
    BaseFileName: file.file_name,
    Size: file.file_size_bytes || 0,
    OwnerId: (file.created_by || '').toString(),
    UserId: tokenPayload.userId,
    UserFriendlyName: tokenPayload.userName,
    UserCanWrite: tokenPayload.canEdit,
    UserCanNotWriteRelative: true,
    PostMessageOrigin: '*',
    EnableInsertRemoteImage: false,
    DisablePrint: !tokenPayload.canDownload,
    DisableExport: !tokenPayload.canDownload,
    DisableCopy: false,
    HideSaveOption: !tokenPayload.canEdit,
    HideExportOption: !tokenPayload.canDownload,
    HidePrintOption: !tokenPayload.canDownload,
  };
};

/* ───────────── WOPI GetFile ───────────── */

/**
 * WOPI GetFile endpoint.
 * Collabora calls this to download the file contents for editing.
 * Streams the file from S3.
 */
const getFileContents = async ({ params, query, res }) => {
  const { fileId } = params;
  const tokenPayload = verifyWopiToken(query.access_token);

  if (tokenPayload.fileId !== fileId) {
    throw new Forbidden('token_file_mismatch');
  }

  const file = await DriveFileRepository.getFile({
    filters: { _id: fileId, project_id: tokenPayload.projectId, deleted_on: 0 },
  });

  if (!file) throw new BadRequest('file_not_found');

  const { s3Key, bucket, region } = getFileS3Info(file);
  if (!s3Key) throw new BadRequest('file_has_no_storage_path');

  const s3 = getS3Client(region);
  const s3Response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));

  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  if (s3Response.ContentLength) {
    res.setHeader('Content-Length', s3Response.ContentLength);
  }

  s3Response.Body.pipe(res);
  return null; // response already handled
};

/* ───────────── WOPI PutFile ───────────── */

/**
 * WOPI PutFile endpoint.
 * Collabora calls this to save the edited file back.
 * Receives the file body, creates a version snapshot, uploads to S3.
 */
const putFileContents = async ({ params, query, req }) => {
  const { fileId } = params;
  const tokenPayload = verifyWopiToken(query.access_token);

  if (tokenPayload.fileId !== fileId) {
    throw new Forbidden('token_file_mismatch');
  }

  if (!tokenPayload.canEdit) {
    throw new Forbidden('no_edit_permission');
  }

  const file = await DriveFileRepository.getFile({
    filters: { _id: fileId, project_id: tokenPayload.projectId, deleted_on: 0 },
  });

  if (!file) throw new BadRequest('file_not_found');

  // req.body is already a Buffer (parsed by express.raw middleware in the route)
  const fileBuffer = req.body;

  const { s3Key, bucket, region } = getFileS3Info(file);
  const s3 = getS3Client(region);

  // Copy current file to a versioned S3 key BEFORE overwriting
  // This preserves the old content so the version snapshot can reference it
  const versionTimestamp = Date.now();
  const ext = s3Key.includes('.') ? s3Key.substring(s3Key.lastIndexOf('.')) : '';
  const basePath = s3Key.includes('.') ? s3Key.substring(0, s3Key.lastIndexOf('.')) : s3Key;
  const versionedS3Key = `${basePath}_v${versionTimestamp}${ext}`;

  try {
    await s3.send(new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${s3Key}`,
      Key: versionedS3Key,
    }));
  } catch (copyErr) {
    console.error('[wopi_putfile] Failed to copy current version to versioned key:', copyErr.message);
    // Continue even if copy fails — don't block the save
  }

  // Create version snapshot pointing to the versioned S3 key (the copy of the old content)
  await DriveVersionService.createVersionSnapshot({
    projectId: tokenPayload.projectId,
    file,
    userId: tokenPayload.userId,
    overrideS3Key: versionedS3Key,
  });

  // Upload new content to S3 (overwrite the original key)

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: s3Key,
    Body: fileBuffer,
    ContentType: file.mime_type || 'application/octet-stream',
  }));

  // Update file record
  const updateData = {
    file_size_bytes: fileBuffer.length,
    file_size: formatFileSize(fileBuffer.length),
    updated_on: Date.now(),
    updated_by: tokenPayload.userId,
  };

  if (file.attachments?.length > 0) {
    updateData.attachments = [{
      ...(file.attachments[0].toObject ? file.attachments[0].toObject() : file.attachments[0]),
      file_size_bytes: fileBuffer.length,
    }];
  }

  await DriveFileRepository.updateFile({
    filters: { _id: fileId, project_id: tokenPayload.projectId },
    data: updateData,
  });

  // Emit socket event for real-time UI update
  socketClient('__admin_events__', {
    event: 'drive:file:updated',
    room: `${tokenPayload.projectId}_room`,
    data: {
      project_id: tokenPayload.projectId,
      file_id: fileId,
      action: 'editor_save',
    },
  });

  // Log activity (fire-and-forget)
  DriveActivityService.log({
    projectId: tokenPayload.projectId,
    userId: tokenPayload.userId,
    action: 'file_updated',
    itemId: fileId,
    itemType: 'file',
    itemName: file.file_name,
    details: { source: 'collabora' },
  });

  console.log(`[wopi_putfile] File saved: ${file.file_name} (${fileBuffer.length} bytes)`);

  return { status: 'ok' };
};

export default {
  generateAccessToken,
  verifyWopiToken,
  checkFileInfo,
  getFileContents,
  putFileContents,
};
