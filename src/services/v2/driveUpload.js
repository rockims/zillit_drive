import {
  S3Client,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';

import BadRequest from 'zillit-libs/errors/BadRequest';
import Forbidden from 'zillit-libs/errors/Forbidden';
import NotificationService from 'zillit-libs/services-v2/notification';
import { rights } from 'zillit-libs/services-v2/permissions';

import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFolderRepository from '../../repositories/v2/driveFolder.js';
import DriveFileAccessRepository from '../../repositories/v2/driveFileAccess.js';
import DriveAccessService from './driveAccess.js';
import DriveFileAccessService from './driveFileAccess.js';
import DriveUploadSession from 'zillit-libs/mongo-models-v2/DriveUploadSession';
import DriveThumbnailService from './driveThumbnail.js';
import socketClient from '../../config/socketClient.js';

const {
  sections, tools, units,
} = NotificationService.NotificationConstants;

// Drive-specific constants — not yet in zillit-libs NotificationConstants
const DRIVE_TOOL = 'drive_label';
const DRIVE_UNIT_FILE = 'drive_file_label';

/* ───────────── S3 Client ───────────── */

const S3_DEFAULT_REGION = process.env.S3_REGION || process.env.AWS_REGION || 'ap-south-1';
const S3_BUCKET = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || 'zillit-bucket-mumbai-dev';
const S3_REGION = S3_DEFAULT_REGION;

// Cache S3 clients per region
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

const s3 = getS3Client(S3_DEFAULT_REGION);
const PRESIGN_EXPIRY_SECONDS = 3600; // 1 hour
const SESSION_TTL_HOURS = 24;

/* ───────────── Adaptive Chunk Sizing ───────────── */

const MB = 1024 * 1024;
const GB = 1024 * MB;

const computeChunkSize = (fileSizeBytes) => {
  if (fileSizeBytes <= 100 * MB) return 8 * MB;
  if (fileSizeBytes <= 1 * GB) return 32 * MB;
  if (fileSizeBytes <= 5 * GB) return 64 * MB;
  return 128 * MB;
};

/* ───────────── Helpers ───────────── */

const toIdString = (value) => (value ? value.toString() : null);

const generateS3Key = (projectId, folderId, fileName) => {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  const sanitised = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const folderPart = folderId ? `/${toIdString(folderId)}` : '';
  return `${toIdString(projectId)}/drive${folderPart}/${timestamp}_${random}_${sanitised}`;
};

const getMimeType = (fileName, providedMime) => {
  if (providedMime) return providedMime;
  const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
  const mimeMap = {
    mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
    mkv: 'video/x-matroska', webm: 'video/webm', wmv: 'video/x-ms-wmv',
    pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
    mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac',
    zip: 'application/zip', rar: 'application/x-rar-compressed',
  };
  return mimeMap[ext] || 'application/octet-stream';
};

const _viewingRightsUsers = async (project) => {
  const usersWithRights = await rights.toolUsersRights({
    projectId: project._id,
    identifier: 'drive_tool',
  });
  return usersWithRights.filter((item) => item.view_access).map((item) => item.user_id.toString());
};

/* ───────────── Initiate Upload ───────────── */

const initiateUpload = async ({ user, project, device, body }) => {
  const { file_name, file_size_bytes, folder_id, mime_type, description, file_access } = body;

  // Validate folder access if uploading into a folder
  if (folder_id) {
    const parentFolder = await DriveFolderRepository.getFolder({
      filters: { _id: folder_id, project_id: project._id, deleted_on: 0 },
    });
    if (!parentFolder) throw new BadRequest('folder_not_found');

    await DriveAccessService.assertFolderAccess({
      user, project, folder: parentFolder, minRole: 'editor',
    });
  }

  // Check duplicate file name in target folder
  const existingFile = await DriveFileRepository.getFile({
    filters: {
      project_id: project._id,
      folder_id: folder_id || null,
      deleted_on: 0,
      file_name: { $regex: new RegExp(`^${file_name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    },
  });
  if (existingFile) throw new BadRequest('duplicate_file_name');

  // Compute chunks
  const chunkSize = computeChunkSize(file_size_bytes);
  const totalParts = Math.ceil(file_size_bytes / chunkSize);
  const resolvedMime = getMimeType(file_name, mime_type);
  const s3Key = generateS3Key(project._id, folder_id, file_name);

  // Create S3 multipart upload
  const createCmd = new CreateMultipartUploadCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    ContentType: resolvedMime,
    Metadata: {
      project_id: toIdString(project._id),
      user_id: toIdString(user._id),
      original_name: encodeURIComponent(file_name),
    },
  });
  const { UploadId: s3UploadId } = await s3.send(createCmd);

  // Generate presigned URLs for all parts
  const presignedUrls = await Promise.all(
    Array.from({ length: totalParts }, async (_, i) => {
      const partNumber = i + 1;
      const cmd = new UploadPartCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        UploadId: s3UploadId,
        PartNumber: partNumber,
      });
      const url = await getSignedUrl(s3, cmd, { expiresIn: PRESIGN_EXPIRY_SECONDS });
      return { part_number: partNumber, url };
    }),
  );

  // Save upload session
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);
  const session = await DriveUploadSession.create({
    project_id: project._id,
    folder_id: folder_id || null,
    user_id: user._id,
    file_name,
    file_size_bytes,
    mime_type: resolvedMime,
    s3_key: s3Key,
    s3_upload_id: s3UploadId,
    s3_bucket: S3_BUCKET,
    s3_region: S3_REGION,
    chunk_size: chunkSize,
    total_parts: totalParts,
    parts: Array.from({ length: totalParts }, (_, i) => ({
      part_number: i + 1,
      etag: '',
      size: i < totalParts - 1 ? chunkSize : file_size_bytes - chunkSize * (totalParts - 1),
      uploaded: false,
    })),
    file_access: file_access || [],
    status: 'active',
    expires_at: expiresAt,
  });

  return {
    upload_id: session._id,
    s3_upload_id: s3UploadId,
    presigned_urls: presignedUrls,
    chunk_size: chunkSize,
    total_parts: totalParts,
    expires_at: expiresAt,
  };
};

/* ───────────── Complete Upload ───────────── */

const completeUpload = async ({ user, project, device, params, body }) => {
  const { uploadId } = params;
  const { parts, file_name: overrideName, description } = body;

  // First try to find an active session
  let session = await DriveUploadSession.findOne({
    _id: uploadId,
    project_id: project._id,
    user_id: user._id,
    status: 'active',
  });

  // Idempotent: if session is already completed (retry after network timeout),
  // find and return the existing file instead of throwing an error
  if (!session) {
    const completedSession = await DriveUploadSession.findOne({
      _id: uploadId,
      project_id: project._id,
      user_id: user._id,
      status: 'completed',
    });

    if (completedSession) {
      // Session was already completed — return the file that was already created
      const existingFile = await DriveFileRepository.getFile({
        filters: {
          project_id: project._id,
          file_path: completedSession.s3_key,
          deleted_on: 0,
        },
      });
      if (existingFile) return existingFile;
    }

    throw new BadRequest('upload_session_not_found');
  }

  // Verify all parts are present
  if (parts.length !== session.total_parts) {
    throw new BadRequest('parts_count_mismatch');
  }

  // Complete S3 multipart upload
  const completeCmd = new CompleteMultipartUploadCommand({
    Bucket: session.s3_bucket,
    Key: session.s3_key,
    UploadId: session.s3_upload_id,
    MultipartUpload: {
      Parts: parts
        .sort((a, b) => a.part_number - b.part_number)
        .map((p) => ({
          PartNumber: p.part_number,
          ETag: p.etag,
        })),
    },
  });
  const s3Result = await s3.send(completeCmd);

  // Mark session completed
  session.status = 'completed';
  session.parts = parts.map((p) => ({
    part_number: p.part_number,
    etag: p.etag,
    uploaded: true,
    size: 0,
  }));
  session.updated_on = Date.now();
  await session.save();

  // Create the DriveFile record
  const fileName = overrideName || session.file_name;
  const fileExtension = fileName.includes('.')
    ? fileName.split('.').pop().toLowerCase()
    : '';

  const fileData = {
    project_id: project._id,
    folder_id: session.folder_id,
    file_name: fileName,
    file_path: session.s3_key,
    description: description || '',
    file_type: session.mime_type.split('/')[0] || '',
    file_extension: fileExtension,
    file_size: _formatFileSize(session.file_size_bytes),
    file_size_bytes: session.file_size_bytes,
    mime_type: session.mime_type,
    attachments: [
      {
        media: session.s3_key,
        name: fileName,
        thumbnail: '',
        content_type: session.mime_type.split('/')[0] || 'document',
        content_subtype: session.mime_type.split('/')[1] || '',
        caption: '',
        duration: 0,
        height: 0,
        width: 0,
        bucket: session.s3_bucket,
        region: session.s3_region,
        created: Date.now(),
        file_size: _formatFileSize(session.file_size_bytes),
        content_id: '',
      },
    ],
    created_by: user._id,
    updated_by: user._id,
    uploaded_by: user._id,
  };

  const file = await DriveFileRepository.createFile({ data: fileData });

  // Seed file-level access permissions
  try {
    await DriveFileAccessService.seedFileAccess({
      project,
      user,
      file,
      entries: session.file_access || [],
    });
  } catch (err) {
    console.error('[file_access_seed_failed]:', err.message);
    // Non-blocking — file is still created even if access seeding fails
  }

  // Send notifications to users who have file-level OR folder-level access
  const fileAccessRecords = await DriveFileAccessRepository.getAccesses({
    filters: {
      project_id: project._id,
      file_id: file._id,
      deleted_on: 0,
    },
  });
  const accessUserIds = fileAccessRecords
    .map((r) => r.user_id?.toString())
    .filter((id) => id && id !== file.created_by?.toString());

  // Also include users with folder-level access (for shared folders)
  let folderAccessUserIds = [];
  if (session.folder_id) {
    const DriveFolderAccess = (await import('zillit-libs/mongo-models-v2/DriveFolderAccess')).default;
    const folderAccessRecords = await DriveFolderAccess.find({
      project_id: project._id,
      folder_id: session.folder_id,
      deleted_on: 0,
    }).lean();
    folderAccessUserIds = folderAccessRecords
      .map((r) => r.user_id?.toString())
      .filter((id) => id && id !== file.created_by?.toString());
  }

  const allReceiverIds = [...new Set([...accessUserIds, ...folderAccessUserIds])];
  const folderId = session.folder_id ? session.folder_id.toString() : null;
  if (allReceiverIds.length === 0) {
    // No one to notify — skip notification but still emit socket event
  } else {
    await NotificationService.notifyAll(
      {
        project,
        sender: file.created_by,
        receiver: allReceiverIds,
        section: sections.TOOLS,
        tool: DRIVE_TOOL,
        unit: DRIVE_UNIT_FILE,
        action: 'drive_file_uploaded',
        reference_id: file._id,
        level_1: folderId || 'root',
        level_2: toIdString(file._id),
        reference_data: {
          file_id: toIdString(file._id),
          file_name: file.file_name,
          folder_id: folderId,
        },
        message: `New file "${file.file_name}" uploaded`,
      },
      { notify: true, save: true },
      socketClient,
    );
  }

  // Emit socket event
  socketClient('__admin_events__', {
    event: 'drive:file:added',
    room: `${project._id.toString()}_room`,
    data: {
      project_id: project._id,
      device_id: device?._id || null,
      folder_id: session.folder_id ? session.folder_id.toString() : null,
      file,
    },
  });

  // Fire-and-forget: generate video thumbnail if applicable
  DriveThumbnailService.generateVideoThumbnail({
    projectId: project._id,
    file,
  }).catch((err) => console.error('[thumbnail] async error:', err.message));

  return file;
};

/* ───────────── Abort Upload ───────────── */

const abortUpload = async ({ user, project, params }) => {
  const { uploadId } = params;

  const session = await DriveUploadSession.findOne({
    _id: uploadId,
    project_id: project._id,
    user_id: user._id,
    status: 'active',
  });

  if (!session) throw new BadRequest('upload_session_not_found');

  // Abort S3 multipart upload
  try {
    const abortCmd = new AbortMultipartUploadCommand({
      Bucket: session.s3_bucket,
      Key: session.s3_key,
      UploadId: session.s3_upload_id,
    });
    await s3.send(abortCmd);
  } catch (err) {
    console.log('[s3_abort_error]:', err.message);
    // Continue even if S3 abort fails — mark session as aborted anyway
  }

  session.status = 'aborted';
  session.updated_on = Date.now();
  await session.save();

  return { message: 'upload_aborted' };
};

/* ───────────── Get Upload Parts (Resume Support) ───────────── */

const getUploadParts = async ({ user, project, params }) => {
  const { uploadId } = params;

  const session = await DriveUploadSession.findOne({
    _id: uploadId,
    project_id: project._id,
    user_id: user._id,
    status: 'active',
  });

  if (!session) throw new BadRequest('upload_session_not_found');

  // Check if session has expired
  if (new Date() > session.expires_at) {
    session.status = 'expired';
    await session.save();
    throw new BadRequest('upload_session_expired');
  }

  // Generate fresh presigned URLs for all parts
  const presignedUrls = await Promise.all(
    Array.from({ length: session.total_parts }, async (_, i) => {
      const partNumber = i + 1;
      const part = session.parts.find((p) => p.part_number === partNumber);
      const cmd = new UploadPartCommand({
        Bucket: session.s3_bucket,
        Key: session.s3_key,
        UploadId: session.s3_upload_id,
        PartNumber: partNumber,
      });
      const url = await getSignedUrl(s3, cmd, { expiresIn: PRESIGN_EXPIRY_SECONDS });
      return {
        part_number: partNumber,
        url,
        uploaded: part?.uploaded || false,
      };
    }),
  );

  return {
    upload_id: session._id,
    file_name: session.file_name,
    file_size_bytes: session.file_size_bytes,
    chunk_size: session.chunk_size,
    total_parts: session.total_parts,
    presigned_urls: presignedUrls,
    expires_at: session.expires_at,
  };
};

/* ───────────── Get Active Sessions ───────────── */

const getActiveSessions = async ({ user, project }) => {
  const sessions = await DriveUploadSession.find({
    project_id: project._id,
    user_id: user._id,
    status: 'active',
    expires_at: { $gt: new Date() },
  })
    .select('_id file_name file_size_bytes chunk_size total_parts folder_id status created_on expires_at')
    .sort({ created_on: -1 })
    .limit(20)
    .lean();

  return sessions;
};

/* ───────────── Utility ───────────── */

const _formatFileSize = (bytes) => {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 2 : 0);
  return `${size} ${units[i]}`;
};

export default {
  initiateUpload,
  completeUpload,
  abortUpload,
  getUploadParts,
  getActiveSessions,
};
