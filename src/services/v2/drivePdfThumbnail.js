import axios from 'axios';
import FormData from 'form-data';
import { PutObjectCommand } from '@aws-sdk/client-s3';

import DriveFileRepository from '../../repositories/v2/driveFile.js';
import socketClient, { buildUserRooms } from '../../config/socketClient.js';
import { getS3Client, getFileS3Info, getObjectBuffer } from '../../utils/driveS3.js';
import { COLLABORA_URL } from './driveEditor.js';

/**
 * Thumbnails for PDFs: page 1 as a small PNG, shown on the file's card and
 * row like an image or video thumbnail.
 *
 * The document editor server (Collabora) renders the page — the same engine
 * that opens the file, so anything it can open gets a faithful picture, and
 * Drive needs no PDF or image library of its own. Its convert-to endpoint
 * only answers servers on its post_allow list, which must include this Drive
 * server's address.
 *
 * Collabora needs both a width and a height to scale, so the page is first
 * rendered at its own size to learn its shape (portrait page, landscape
 * slide), then at thumbnail size. Page 1 of a 375-page PDF takes ~0.45s.
 *
 * Runs after upload, one at a time, and never fails the upload.
 * Switch: DRIVE_PDF_THUMBNAILS_ENABLED=false.
 */

const ENABLED = process.env.DRIVE_PDF_THUMBNAILS_ENABLED !== 'false';
const MAX_BYTES = Number(process.env.DRIVE_PDF_THUMBNAIL_MAX_BYTES) || 50 * 1024 * 1024;
const TIMEOUT_MS = Number(process.env.DRIVE_PDF_THUMBNAIL_TIMEOUT_MS) || 60 * 1000;
const WIDTH = 320;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 480;
// Uploads waiting beyond this are dropped (logged); the backfill picks them up.
const MAX_QUEUE = 200;
const THUMBNAIL_SUFFIX = '-thumb.png';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const attachmentOf = (file) => file?.attachments?.[0] || {};

const isPdfFile = (file) => {
  if (!file) return false;
  const attachment = attachmentOf(file);
  const mime = String(file.mime_type
    || (attachment.content_type && attachment.content_subtype
      ? `${attachment.content_type}/${attachment.content_subtype}`
      : attachment.content_type)
    || '').toLowerCase();
  const extension = String(file.file_extension || '').toLowerCase().replace(/^\./, '');
  return mime === 'application/pdf' || extension === 'pdf' || /\.pdf$/i.test(file.file_name || '');
};

// Width and height of a PNG, from its header; null if it isn't one.
const pngSize = (buffer) => {
  if (!buffer || buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};

// Thumbnail size keeping the page's shape: 320px wide, height clamped.
const thumbnailSizeFor = ({ width, height }) => {
  const scaled = Math.round((WIDTH * height) / Math.max(width, 1));
  return { width: WIDTH, height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, scaled)) };
};

const thumbnailKeyFor = (s3Key) => `${s3Key.replace(/\.[^./]+$/, '')}${THUMBNAIL_SUFFIX}`;

/**
 * Page 1 of a document as a PNG, from the editor server. With a size, the
 * page is scaled to exactly that size.
 */
const renderFirstPage = async (buffer, { fileName = 'document.pdf', size = null } = {}) => {
  const form = new FormData();
  form.append('data', buffer, { filename: fileName });
  if (size) {
    form.append('options', JSON.stringify({
      PixelWidth: { type: 'long', value: String(size.width) },
      PixelHeight: { type: 'long', value: String(size.height) },
    }));
  }
  const response = await axios.post(`${COLLABORA_URL}/cool/convert-to/png`, form, {
    headers: form.getHeaders(),
    responseType: 'arraybuffer',
    timeout: TIMEOUT_MS,
    maxBodyLength: Infinity,
    maxContentLength: 20 * 1024 * 1024,
  });
  const png = Buffer.from(response.data);
  if (!pngSize(png)) throw new Error('not_a_png');
  return png;
};

/**
 * Make, store and attach the thumbnail for one PDF. Returns the thumbnail's
 * S3 key, or null when the file is skipped or anything fails.
 */
const generatePdfThumbnail = async ({
  projectId, file, notifyUserIds = null, reason = 'upload',
}) => {
  if (!ENABLED || !isPdfFile(file)) return null;
  // A thumbnail the uploading app sent is kept.
  if (attachmentOf(file).thumbnail) return null;
  const { s3Key, bucket, region } = getFileS3Info(file);
  if (!s3Key) return null;
  if ((file.file_size_bytes || 0) > MAX_BYTES) {
    console.log(`[pdf_thumbnail_skipped] file=${file._id} reason=too_large bytes=${file.file_size_bytes}`);
    return null;
  }

  try {
    const pdf = await getObjectBuffer({ bucket, key: s3Key, region });
    const fileName = 'source.pdf';
    const fullPage = await renderFirstPage(pdf, { fileName });
    const pageSize = pngSize(fullPage);
    const png = pageSize.width <= WIDTH
      ? fullPage
      : await renderFirstPage(pdf, { fileName, size: thumbnailSizeFor(pageSize) });

    const thumbKey = thumbnailKeyFor(s3Key);
    await getS3Client(region).send(new PutObjectCommand({
      Bucket: bucket,
      Key: thumbKey,
      Body: png,
      ContentType: 'image/png',
    }));

    // Only the thumbnail changes: "Date modified" stays as it was.
    const updated = await DriveFileRepository.updateFileDocument({
      filters: { _id: file._id, project_id: projectId },
      data: { 'attachments.0.thumbnail': thumbKey },
    });

    // Lets the uploader's open list pick the thumbnail up without a reload.
    if (updated && notifyUserIds?.length) {
      socketClient('__admin_events__', {
        event: 'drive:file:updated',
        room: buildUserRooms(notifyUserIds),
        data: {
          project_id: projectId,
          folder_id: updated.folder_id ? updated.folder_id.toString() : null,
          file: updated,
        },
      });
    }
    console.log(`[pdf_thumbnail_created] file=${file._id} reason=${reason} bytes=${png.length}`);
    return thumbKey;
  } catch (error) {
    const status = error.response?.status ? ` status=${error.response.status}` : '';
    console.error(`[pdf_thumbnail_failed] file=${file._id} reason=${reason}${status} error=${error.message}`);
    return null;
  }
};

// One at a time, so a folder of PDFs doesn't hit the editor server at once.
let tail = Promise.resolve();
let waiting = 0;

const queuePdfThumbnail = (job) => {
  if (!ENABLED || !isPdfFile(job?.file)) return false;
  if (waiting >= MAX_QUEUE) {
    console.warn(`[pdf_thumbnail_dropped] file=${job.file._id} reason=queue_full`);
    return false;
  }
  waiting += 1;
  // eslint-disable-next-line no-use-before-define
  tail = tail
    .then(() => DrivePdfThumbnail.generatePdfThumbnail(job))
    .catch((error) => console.error(`[pdf_thumbnail_failed] file=${job.file._id} error=${error.message}`))
    .finally(() => { waiting -= 1; });
  return true;
};

const DrivePdfThumbnail = {
  isPdfFile,
  generatePdfThumbnail,
  queuePdfThumbnail,
};

export {
  pngSize,
  thumbnailSizeFor,
  thumbnailKeyFor,
  renderFirstPage,
  WIDTH,
  MAX_HEIGHT,
};

export default DrivePdfThumbnail;
