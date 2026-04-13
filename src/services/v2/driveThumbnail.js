import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import ffmpeg from 'fluent-ffmpeg';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';
import os from 'os';
import DriveFileRepository from '../../repositories/v2/driveFile.js';

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
 * DriveThumbnailService — extract video frame thumbnails.
 * Called after completeUpload for video files.
 */

const VIDEO_MIME_PREFIXES = ['video/'];
const THUMBNAIL_SUFFIX = '-thumb.jpg';

const isVideoFile = (mimeType) => {
  if (!mimeType) return false;
  return VIDEO_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
};

/**
 * Generate a thumbnail for a video file.
 * 1. Downloads the video from S3 to a temp file
 * 2. Extracts a frame at 1s using ffmpeg
 * 3. Uploads the thumbnail to S3
 * 4. Updates the DriveFile record with the thumbnail key
 *
 * @param {Object} params
 * @param {string} params.projectId
 * @param {Object} params.file — DriveFile document
 */
const generateVideoThumbnail = async ({ projectId, file }) => {
  // Resolve MIME from multiple sources — attachments store type/subtype separately
  const attachment = file.attachments?.[0] || {};
  const mimeType = file.mime_type
    || (attachment.content_type && attachment.content_subtype
      ? `${attachment.content_type}/${attachment.content_subtype}`
      : attachment.content_type)
    || '';

  if (!isVideoFile(mimeType)) return null;

  const s3Key = file.file_path
    || file.attachments?.[0]?.media
    || file.attachments?.[0]?.file_path;

  if (!s3Key) return null;

  const bucket = attachment.bucket || S3_BUCKET;
  const region = attachment.region || S3_DEFAULT_REGION;
  const s3 = getS3Client(region);

  // Temp paths
  const tmpDir = os.tmpdir();
  const videoTmpPath = path.join(tmpDir, `video-${file._id}-${Date.now()}`);
  const thumbTmpPath = path.join(tmpDir, `thumb-${file._id}-${Date.now()}.jpg`);

  try {
    // 1. Download video to temp
    const getCmd = new GetObjectCommand({ Bucket: bucket, Key: s3Key });
    const s3Resp = await s3.send(getCmd);

    const writeStream = fs.createWriteStream(videoTmpPath);
    await new Promise((resolve, reject) => {
      s3Resp.Body.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    // 2. Extract a frame at 1 second via ffmpeg
    await new Promise((resolve, reject) => {
      ffmpeg(videoTmpPath)
        .screenshots({
          count: 1,
          timemarks: ['00:00:01'],
          filename: path.basename(thumbTmpPath),
          folder: tmpDir,
          size: '320x?', // 320px wide, auto height
        })
        .on('end', resolve)
        .on('error', (err) => {
          console.error('[thumbnail] ffmpeg error:', err.message);
          reject(err);
        });
    });

    // 3. Upload thumbnail to S3
    const thumbKey = s3Key.replace(/\.[^.]+$/, '') + THUMBNAIL_SUFFIX;
    const thumbBuffer = fs.readFileSync(thumbTmpPath);

    const putCmd = new PutObjectCommand({
      Bucket: bucket,
      Key: thumbKey,
      Body: thumbBuffer,
      ContentType: 'image/jpeg',
    });
    await s3.send(putCmd);

    // 4. Update DriveFile with thumbnail key
    const updatedAttachments = [...(file.attachments || [])];
    if (updatedAttachments[0]) {
      updatedAttachments[0] = {
        ...updatedAttachments[0].toObject ? updatedAttachments[0].toObject() : updatedAttachments[0],
        thumbnail: thumbKey,
      };
    }

    await DriveFileRepository.updateFile({
      filters: { _id: file._id, project_id: projectId },
      data: {
        attachments: updatedAttachments,
        updated_on: Date.now(),
      },
    });

    return thumbKey;
  } catch (err) {
    console.error('[thumbnail] Failed to generate thumbnail:', err.message);
    return null;
  } finally {
    // Cleanup temp files
    try { fs.unlinkSync(videoTmpPath); } catch {}
    try { fs.unlinkSync(thumbTmpPath); } catch {}
  }
};

export default {
  generateVideoThumbnail,
  isVideoFile,
};
