import mongoose from 'mongoose';
import BadRequest from 'zillit-libs/errors/BadRequest';
import Forbidden from 'zillit-libs/errors/Forbidden';
import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFileVersionRepository from '../../repositories/v2/driveFileVersion.js';
import DriveFileAccessService from './driveFileAccess.js';
import DriveVersionStore from './driveVersionStore.js';
import { announceSavedVersion } from './driveVersionEvents.js';
import { contentTimeOf } from './driveWopi.js';
import { getFileS3Info, getObjectBuffer } from '../../utils/driveS3.js';

/**
 * Markdown files are read and edited as text in Drive's own viewer, not in
 * the document editor (which would turn them into a word-processor file).
 *
 * A save goes through the same version store as an editor save, so version
 * history, restore and "who edited" work for these files too.
 */

const TEXT_EXTENSIONS = new Set(['md', 'markdown']);
const MAX_BYTES = Number(process.env.DRIVE_TEXT_FILE_MAX_BYTES) || 2 * 1024 * 1024;

// Someone else saved the file after this person opened it.
class TextConflict extends Error {
  constructor(message = 'file_changed_since_opened') {
    super(message);
    this.status = 409;
  }
}

const isTextFile = (file) => TEXT_EXTENSIONS.has(DriveVersionStore.extensionOf(file));

// UTF-8, without the byte-order mark some Windows editors add.
const decode = (buffer) => buffer.toString('utf8').replace(/^﻿/, '');

const loadTextFile = async ({ project, fileId }) => {
  const file = await DriveFileRepository.getFile({
    filters: { _id: fileId, project_id: project._id, deleted_on: 0 },
  });
  if (!file) throw new BadRequest('file_not_found');
  if (!isTextFile(file)) throw new BadRequest('file_type_not_text_editable');
  return file;
};

/**
 * GET /files/:fileId/text[?version_id=…]
 * The file's text for the viewer, or a saved version's for history.
 */
const getText = async ({
  user, project, params, query = {},
}) => {
  const file = await loadTextFile({ project, fileId: params.fileId });
  const permissions = await DriveFileAccessService.resolveFilePermission({ user, project, file });
  if (!permissions || !permissions.can_view) throw new Forbidden('insufficient_permissions');

  let source = getFileS3Info(file);
  let sizeBytes = file.file_size_bytes;
  let version = null;
  if (query.version_id) {
    if (!mongoose.isValidObjectId(query.version_id)) throw new BadRequest('version_not_found');
    version = await DriveFileVersionRepository.getVersion({
      filters: { _id: query.version_id, file_id: file._id, project_id: project._id },
    });
    if (!version) throw new BadRequest('version_not_found');
    source = { s3Key: version.s3_key, bucket: version.s3_bucket, region: version.s3_region };
    sizeBytes = version.file_size_bytes;
  }
  if (!source.s3Key) throw new BadRequest('file_has_no_storage_path');
  if (sizeBytes > MAX_BYTES) throw new BadRequest('file_too_large_to_open_as_text');

  const buffer = await getObjectBuffer({ bucket: source.bucket, key: source.s3Key, region: source.region });
  if (buffer.length > MAX_BYTES) throw new BadRequest('file_too_large_to_open_as_text');

  return {
    file_id: file._id,
    file_name: file.file_name,
    content: decode(buffer),
    content_time: contentTimeOf(file),
    // A saved version is always read-only.
    can_edit: !!permissions.can_edit && !version,
    version_id: version ? version._id : null,
    version_number: version ? version.version_number : null,
  };
};

/**
 * PUT /files/:fileId/text[?content_time=…]   body: the text
 *
 * `content_time` is the value the viewer got when it opened the file. If
 * the file has been saved since, the save is refused rather than writing
 * over the other person's work; leaving it out overwrites on purpose.
 */
const saveText = async ({
  user, project, params, query = {}, text,
}) => {
  const file = await loadTextFile({ project, fileId: params.fileId });
  const permissions = await DriveFileAccessService.resolveFilePermission({ user, project, file });
  if (!permissions || !permissions.can_view) throw new Forbidden('insufficient_permissions');
  if (!permissions.can_edit) throw new Forbidden('no_edit_permission');

  if (typeof text !== 'string') throw new BadRequest('file_body_missing');
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length > MAX_BYTES) throw new BadRequest('file_too_large_to_save_as_text');

  const openedAt = Number(query.content_time);
  if (query.content_time !== undefined && query.content_time !== ''
    && (!Number.isFinite(openedAt) || openedAt !== contentTimeOf(file))) {
    throw new TextConflict();
  }

  const result = await DriveVersionStore.recordEditorSave({
    file,
    projectId: project._id,
    userId: user._id,
    buffer,
    saveType: 'manual',
  });
  if (result.skipped) {
    return { saved: false, content_time: contentTimeOf(file) };
  }

  const { version, savedAt } = result;
  announceSavedVersion({
    projectId: project._id,
    userId: user._id,
    file,
    version,
    source: 'text_editor',
  });
  console.log(`[text_file_saved] ${file.file_name} v${version.version_number} (${buffer.length} bytes)`);

  return {
    saved: true,
    content_time: savedAt,
    version_id: version._id,
    version_number: version.version_number,
  };
};

export {
  TEXT_EXTENSIONS,
  MAX_BYTES,
  TextConflict,
  isTextFile,
};

export default {
  getText,
  saveText,
};
