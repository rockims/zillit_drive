import { S3Client, GetObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import DriveFileVersion from 'zillit-libs/mongo-models-v2/DriveFileVersion';
import DriveFileRepository from '../../repositories/v2/driveFile.js';
import BadRequest from 'zillit-libs/errors/BadRequest';

const S3_DEFAULT_REGION = process.env.AWS_REGION || 'ap-south-1';
const S3_BUCKET = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || 'zillit-drive';

const s3ClientCache = {};
const getS3Client = (region) => {
  const r = region || S3_DEFAULT_REGION;
  if (!s3ClientCache[r]) {
    s3ClientCache[r] = new S3Client({ region: r });
  }
  return s3ClientCache[r];
};

/**
 * DriveVersionService — manage file version history.
 */

// ── List versions for a file ──
const listVersions = async ({ project, params }) => {
  const { fileId } = params;

  const file = await DriveFileRepository.getFile({
    filters: { _id: fileId, project_id: project._id, deleted_on: 0 },
  });

  if (!file) throw new BadRequest('file_not_found');

  const versions = await DriveFileVersion.find({
    project_id: project._id,
    file_id: fileId,
  }).sort({ version_number: -1 });

  return versions;
};

// ── Save current file state as a version (called before overwriting) ──
// @param overrideS3Key — if provided, use this key instead of the file's current S3 key
//   (used when the caller copies the old content to a versioned key before overwriting)
const createVersionSnapshot = async ({ projectId, file, userId, overrideS3Key = null }) => {
  // Determine the next version number
  const latestVersion = await DriveFileVersion.findOne({
    project_id: projectId,
    file_id: file._id,
  }).sort({ version_number: -1 });

  const nextVersion = latestVersion ? latestVersion.version_number + 1 : 1;

  // Extract S3 key from file (or use the override if provided)
  const s3Key = overrideS3Key
    || file.file_path
    || file.attachments?.[0]?.media
    || file.attachments?.[0]?.file_path;

  if (!s3Key) return null; // no S3 key, can't snapshot

  const attachment = file.attachments?.[0] || {};

  const version = await DriveFileVersion.create({
    project_id: projectId,
    file_id: file._id,
    version_number: nextVersion,
    file_name: file.file_name,
    file_size_bytes: file.file_size_bytes || 0,
    mime_type: file.mime_type || attachment.content_type || '',
    s3_key: s3Key,
    s3_bucket: attachment.bucket || S3_BUCKET,
    s3_region: attachment.region || S3_DEFAULT_REGION,
    uploaded_by: userId,
  });

  return version;
};

// ── Get presigned download URL for a specific version ──
const getVersionDownloadUrl = async ({ project, params }) => {
  const { fileId, versionId } = params;

  const version = await DriveFileVersion.findOne({
    _id: versionId,
    project_id: project._id,
    file_id: fileId,
  });

  if (!version) throw new BadRequest('version_not_found');

  const s3ForRegion = getS3Client(version.s3_region);

  const cmd = new GetObjectCommand({
    Bucket: version.s3_bucket,
    Key: version.s3_key,
    ResponseContentDisposition: `attachment; filename="${encodeURIComponent(version.file_name || 'download')}"`,
  });

  const url = await getSignedUrl(s3ForRegion, cmd, { expiresIn: 3600 });

  return {
    url,
    file_name: version.file_name,
    file_size_bytes: version.file_size_bytes,
    version_number: version.version_number,
  };
};

// ── Restore a specific version (makes it the current file) ──
const restoreVersion = async ({ user, project, params }) => {
  const { fileId, versionId } = params;

  const version = await DriveFileVersion.findOne({
    _id: versionId,
    project_id: project._id,
    file_id: fileId,
  });

  if (!version) throw new BadRequest('version_not_found');

  const file = await DriveFileRepository.getFile({
    filters: { _id: fileId, project_id: project._id, deleted_on: 0 },
  });

  if (!file) throw new BadRequest('file_not_found');

  // Get the current file's S3 info
  const currentS3Key = file.file_path
    || file.attachments?.[0]?.media
    || file.attachments?.[0]?.file_path;
  const currentBucket = file.attachments?.[0]?.bucket || S3_BUCKET;
  const currentRegion = file.attachments?.[0]?.region || S3_DEFAULT_REGION;

  // Copy current file to a versioned S3 key before overwriting
  const versionTimestamp = Date.now();
  const ext = currentS3Key?.includes('.') ? currentS3Key.substring(currentS3Key.lastIndexOf('.')) : '';
  const basePath = currentS3Key?.includes('.') ? currentS3Key.substring(0, currentS3Key.lastIndexOf('.')) : currentS3Key;
  const versionedS3Key = `${basePath}_v${versionTimestamp}${ext}`;

  if (currentS3Key) {
    try {
      const s3 = getS3Client(currentRegion);
      await s3.send(new CopyObjectCommand({
        Bucket: currentBucket,
        CopySource: `${currentBucket}/${currentS3Key}`,
        Key: versionedS3Key,
      }));
    } catch (copyErr) {
      console.error('[restore_version] Failed to copy current file:', copyErr.message);
    }
  }

  // Snapshot the current file before restoring (using versioned copy key)
  await createVersionSnapshot({ projectId: project._id, file, userId: user._id, overrideS3Key: versionedS3Key });

  // Copy the old version's S3 object back to the original key
  if (version.s3_key && currentS3Key) {
    try {
      const s3 = getS3Client(version.s3_region || S3_DEFAULT_REGION);
      await s3.send(new CopyObjectCommand({
        Bucket: currentBucket,
        CopySource: `${version.s3_bucket}/${version.s3_key}`,
        Key: currentS3Key,
      }));
    } catch (copyErr) {
      console.error('[restore_version] Failed to copy restored version:', copyErr.message);
    }
  }

  // Restore — update the file metadata (keep original S3 key, content was copied back)
  const now = Date.now();
  await DriveFileRepository.updateFile({
    filters: { _id: fileId, project_id: project._id },
    data: {
      file_name: version.file_name,
      file_size_bytes: version.file_size_bytes,
      mime_type: version.mime_type,
      updated_by: user._id,
      updated_on: now,
    },
  });

  return { message: 'Version restored', version_number: version.version_number };
};

export default {
  listVersions,
  createVersionSnapshot,
  getVersionDownloadUrl,
  restoreVersion,
};
