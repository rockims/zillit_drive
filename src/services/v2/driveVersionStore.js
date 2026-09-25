import crypto from 'crypto';
import path from 'path';
import mongoose from 'mongoose';
import { PutObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';

import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFileVersionRepository from '../../repositories/v2/driveFileVersion.js';
import DriveEditPresenceService from './driveEditPresence.js';
import { getS3Client, getFileS3Info, copySource } from '../../utils/driveS3.js';

/**
 * Writes Drive file versions.
 *
 * A version is the file's content *after* a save, labelled with the person
 * who saved it, when, how (autosave / manual / on close / restore), and
 * everyone who was editing since the previous version. Each version keeps
 * its own copy in S3; the file's usual key always holds the latest.
 *
 * Records written before this existed ("legacy") are snapshots of the
 * content *before* a save instead. Readers relabel them (see
 * driveVersion.js); this module never rewrites them.
 */

// Saves closer together than this belong to one editing session.
const SESSION_GAP_MS = 30 * 60 * 1000;
const EDITOR_SAVE_TYPES = ['autosave', 'manual', 'exit'];
// Spreadsheet formats the comparison can read.
const COMPARABLE_EXTENSIONS = new Set(['xlsx', 'xlsm', 'xls', 'ods', 'csv']);
const COMPARE_MAX_BYTES = Number(process.env.DRIVE_VERSION_DIFF_MAX_BYTES) || 20 * 1024 * 1024;

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const extensionOf = (file) => String(file.file_extension || path.extname(file.file_name || ''))
  .toLowerCase()
  .replace(/^\./, '');

const formatFileSize = (bytes) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** i)).toFixed(2)} ${units[i]}`;
};

const versionKeyFor = ({ projectId, file, number }) => {
  const ext = extensionOf(file);
  return `${projectId}/drive/versions/${file._id}/${number}-${Date.now()}${ext ? `.${ext}` : ''}`;
};

// Whether (and why not) a version gets compared with the one before it.
const comparisonFor = ({ file, sizeBytes, hasPrevious }) => {
  if (!hasPrevious) return { status: 'none', reason: '' };
  if (!COMPARABLE_EXTENSIONS.has(extensionOf(file))) return { status: 'skipped', reason: 'unsupported_type' };
  if (sizeBytes > COMPARE_MAX_BYTES) return { status: 'skipped', reason: 'too_large' };
  return { status: 'pending', reason: '' };
};

const nextVersionNumber = async (fileId) => {
  const latest = await DriveFileVersionRepository.getLatestVersion({ fileId });
  await DriveFileRepository.raiseVersionSeqFloor({ fileId, floor: latest?.version_number || 0 });
  return DriveFileRepository.incrementVersionSeq({ fileId });
};

const attachmentsWithSize = (file, sizeBytes) => {
  if (!file.attachments?.length) return undefined;
  const first = file.attachments[0].toObject ? file.attachments[0].toObject() : file.attachments[0];
  return [{ ...first, file_size_bytes: sizeBytes }, ...file.attachments.slice(1)];
};

/**
 * Make sure the file's current content is itself a version, so the history
 * starts from what was there before the first tracked save.
 *
 * For a file with legacy records, its content came from the save that
 * wrote the newest legacy record, by that record's person, at its time.
 * Otherwise it's the upload.
 */
const ensureBaseline = async ({ file, projectId }) => {
  if (file.current_version_id) {
    const current = await DriveFileVersionRepository.getVersion({
      filters: { _id: file.current_version_id, file_id: file._id },
    });
    if (current) return current;
  }

  const { s3Key, bucket, region } = getFileS3Info(file);
  if (!s3Key) return null;

  const newestLegacy = await DriveFileVersionRepository.getLatestVersion({ fileId: file._id });
  const fromLegacy = !!newestLegacy && !newestLegacy.saved_by;
  const savedBy = fromLegacy
    ? newestLegacy.uploaded_by
    : (file.uploaded_by || file.created_by || file.updated_by);
  const savedAt = fromLegacy
    ? newestLegacy.created_on
    : (file.content_updated_on || file.created_on || Date.now());

  const number = await nextVersionNumber(file._id);
  const key = versionKeyFor({ projectId, file, number });
  await getS3Client(region).send(new CopyObjectCommand({
    Bucket: bucket,
    CopySource: copySource(bucket, s3Key),
    Key: key,
  }));

  const baseline = await DriveFileVersionRepository.createVersion({
    data: {
      project_id: projectId,
      file_id: file._id,
      version_number: number,
      file_name: file.file_name,
      file_size_bytes: file.file_size_bytes || 0,
      mime_type: file.mime_type || '',
      s3_key: key,
      s3_bucket: bucket,
      s3_region: region,
      uploaded_by: savedBy,
      saved_by: savedBy,
      saved_at: savedAt,
      save_type: fromLegacy ? 'legacy' : 'upload',
      editors: savedBy ? [savedBy] : [],
      session_id: '',
      content_sha256: file.content_sha256 || '',
      changes: { status: 'none' },
    },
  });

  await DriveFileRepository.updateFile({
    filters: { _id: file._id },
    data: { current_version_id: baseline._id },
  });
  return baseline;
};

const sessionFor = ({ previous, saveType, now }) => {
  const continues = previous
    && previous.session_id
    && EDITOR_SAVE_TYPES.includes(saveType)
    && EDITOR_SAVE_TYPES.includes(previous.save_type)
    && now - (previous.saved_at || 0) < SESSION_GAP_MS;
  return continues ? previous.session_id : new mongoose.Types.ObjectId().toString();
};

/**
 * Record a save from the document editor.
 *
 * Skipped (nothing written) when the editor says the user didn't change
 * anything, e.g. the automatic re-save after opening a large spreadsheet,
 * or when the content is byte-for-byte the current version.
 *
 * Returns { skipped } or { version, savedAt }.
 */
const recordEditorSave = async ({
  file, projectId, userId, buffer, saveType = 'manual', modifiedByUser = true,
}) => {
  if (modifiedByUser === false) return { skipped: 'not_modified_by_user' };

  const hash = sha256(buffer);
  if (file.content_sha256 && file.content_sha256 === hash) return { skipped: 'identical' };

  const { s3Key, bucket, region } = getFileS3Info(file);
  if (!s3Key) throw new Error('file_has_no_storage_path');

  const previous = await ensureBaseline({ file, projectId });
  const number = await nextVersionNumber(file._id);
  const key = versionKeyFor({ projectId, file, number });
  const s3 = getS3Client(region);

  // The version's own copy first, then the live key from it (an S3-side
  // copy, so the bytes cross the network once).
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: file.mime_type || 'application/octet-stream',
  }));
  await s3.send(new CopyObjectCommand({
    Bucket: bucket,
    CopySource: copySource(bucket, key),
    Key: s3Key,
    ContentType: file.mime_type || 'application/octet-stream',
    MetadataDirective: 'REPLACE',
  }));

  const now = Date.now();
  const editors = await DriveEditPresenceService.editorsSince({
    fileId: file._id,
    since: previous?.saved_at || now - SESSION_GAP_MS,
    include: userId,
  });
  const comparison = comparisonFor({ file, sizeBytes: buffer.length, hasPrevious: !!previous });

  const version = await DriveFileVersionRepository.createVersion({
    data: {
      project_id: projectId,
      file_id: file._id,
      version_number: number,
      file_name: file.file_name,
      file_size_bytes: buffer.length,
      mime_type: file.mime_type || '',
      s3_key: key,
      s3_bucket: bucket,
      s3_region: region,
      uploaded_by: userId,
      saved_by: userId,
      saved_at: now,
      save_type: saveType,
      editors,
      session_id: sessionFor({ previous, saveType, now }),
      content_sha256: hash,
      changes: comparison,
    },
  });

  const data = {
    file_size_bytes: buffer.length,
    file_size: formatFileSize(buffer.length),
    updated_on: now,
    updated_by: userId,
    content_updated_on: now,
    content_sha256: hash,
    current_version_id: version._id,
  };
  const attachments = attachmentsWithSize(file, buffer.length);
  if (attachments) data.attachments = attachments;
  await DriveFileRepository.updateFile({ filters: { _id: file._id }, data });

  return { version, savedAt: now };
};

/**
 * Make an earlier version the current content again. The content before
 * the restore stays in the history, and the restore is a version of its
 * own, so it can be undone the same way.
 */
const restoreFromVersion = async ({
  file, projectId, userId, version,
}) => {
  const { s3Key, bucket, region } = getFileS3Info(file);
  if (!s3Key || !version.s3_key) throw new Error('version_has_no_storage_path');

  const previous = await ensureBaseline({ file, projectId });
  const number = await nextVersionNumber(file._id);
  const key = versionKeyFor({ projectId, file, number });
  const s3 = getS3Client(region);

  // Both copies must succeed; a failed restore must not report success.
  await s3.send(new CopyObjectCommand({
    Bucket: bucket,
    CopySource: copySource(version.s3_bucket || bucket, version.s3_key),
    Key: key,
  }));
  await s3.send(new CopyObjectCommand({
    Bucket: bucket,
    CopySource: copySource(bucket, key),
    Key: s3Key,
  }));

  const now = Date.now();
  const sizeBytes = version.file_size_bytes || 0;
  const comparison = comparisonFor({ file, sizeBytes, hasPrevious: !!previous });
  const restored = await DriveFileVersionRepository.createVersion({
    data: {
      project_id: projectId,
      file_id: file._id,
      version_number: number,
      file_name: file.file_name,
      file_size_bytes: sizeBytes,
      mime_type: version.mime_type || file.mime_type || '',
      s3_key: key,
      s3_bucket: bucket,
      s3_region: region,
      uploaded_by: userId,
      saved_by: userId,
      saved_at: now,
      save_type: 'restore',
      editors: [userId],
      session_id: new mongoose.Types.ObjectId().toString(),
      content_sha256: version.content_sha256 || '',
      restored_from: version._id,
      changes: comparison,
    },
  });

  const data = {
    file_size_bytes: sizeBytes,
    file_size: formatFileSize(sizeBytes),
    updated_on: now,
    updated_by: userId,
    content_updated_on: now,
    content_sha256: version.content_sha256 || '',
    current_version_id: restored._id,
  };
  const attachments = attachmentsWithSize(file, sizeBytes);
  if (attachments) data.attachments = attachments;
  await DriveFileRepository.updateFile({ filters: { _id: file._id }, data });

  return { version: restored, savedAt: now };
};

export {
  SESSION_GAP_MS,
  COMPARE_MAX_BYTES,
  COMPARABLE_EXTENSIONS,
};

export default {
  ensureBaseline,
  recordEditorSave,
  restoreFromVersion,
  comparisonFor,
  sessionFor,
  extensionOf,
};
