import BadRequest from 'zillit-libs/errors/BadRequest';

import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFolderRepository from '../../repositories/v2/driveFolder.js';

/**
 * driveNameResolver — Finder/Dropbox-style "never block on duplicate".
 *
 * Drive is a Private Drive (ZL-18867): name uniqueness is scoped PER USER
 * within a folder, so a name another user owns in the same folder
 * (including files shared into your view) never collides with yours.
 *
 * For CREATE / UPLOAD / MOVE we go one step further than rejecting: if the
 * SAME user already has the same name in the target folder, we auto-append
 * a " (N)" suffix instead of throwing:
 *
 *   report.pdf  →  report.pdf, report (1).pdf, report (2).pdf
 *   report      →  report, report (1), report (2)
 *   v1.0.tar.gz →  v1.0.tar.gz, v1.0.tar (1).gz   (suffix before LAST dot)
 *
 * N is the smallest available positive integer, so a gap left by a deleted
 * sibling gets reused (matches Finder). The returned name equals the input
 * when the original was already free.
 *
 * RENAME deliberately does NOT use this — renaming to an already-taken name
 * is an explicit user action with a specific target, so those paths keep
 * throwing duplicate_*_name (Finder blocks rename-to-existing too).
 */

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Split on the LAST dot (dot>0 so dotfiles like ".env" keep their whole name
// as the stem). "v1.0.tar.gz" → { stem: "v1.0.tar", ext: ".gz" }.
const splitName = (name) => {
  const dot = name.lastIndexOf('.');
  return dot > 0
    ? { stem: name.slice(0, dot), ext: name.slice(dot) }
    : { stem: name, ext: '' };
};

// Regex matching the bare "<stem><ext>" AND any "<stem> (N)<ext>" sibling,
// case-insensitive — lets us pull the whole name family in one query.
const familyRegex = (stem, ext) => new RegExp(`^${escapeRegex(stem)}( \\(\\d+\\))?${escapeRegex(ext)}$`, 'i');

// Pure: given the desired (trimmed) name and a Set of already-taken names
// (lower-cased), return the first free name. Smallest free suffix wins, so
// deletion gaps are reused. Returns null past a sane ceiling so the caller
// can throw a deterministic error instead of looping forever.
const pickFreeName = (desired, takenLower) => {
  if (!takenLower.has(desired.toLowerCase())) return desired;
  const { stem, ext } = splitName(desired);
  for (let i = 1; i <= 10000; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!takenLower.has(candidate.toLowerCase())) return candidate;
  }
  return null;
};

/**
 * Resolve a non-colliding file name in (project, folder, user) scope.
 * @param {Object}  args
 * @param {string}  args.fileName     desired file name
 * @param {*}       args.projectId
 * @param {*}       [args.folderId]   null/undefined = root
 * @param {*}       args.createdBy    the uploading/creating user's _id
 * @param {*}       [args.excludeId]  file _id to exclude (e.g. the item being moved)
 * @returns {Promise<string>} the available name (== input when already free)
 */
const resolveAvailableFileName = async ({
  fileName, projectId, folderId, createdBy, excludeId,
}) => {
  const trimmed = String(fileName || '').trim();
  if (!trimmed) return trimmed;

  const { stem, ext } = splitName(trimmed);
  const filters = {
    project_id: projectId,
    folder_id: folderId || null,
    created_by: createdBy,
    deleted_on: 0,
    file_name: { $regex: familyRegex(stem, ext) },
  };
  if (excludeId) filters._id = { $ne: excludeId };

  const existing = await DriveFileRepository.getFiles({ filters, sort: { _id: 1 } });
  const takenLower = new Set(
    existing.map((f) => String(f?.file_name || '').trim().toLowerCase()),
  );

  const free = pickFreeName(trimmed, takenLower);
  if (!free) throw new BadRequest('too_many_duplicate_file_names');
  return free;
};

/**
 * Resolve a non-colliding folder name in (project, parent, user) scope.
 * @param {Object}  args
 * @param {string}  args.folderName       desired folder name
 * @param {*}       args.projectId
 * @param {*}       [args.parentFolderId] null/undefined = root
 * @param {*}       args.createdBy
 * @param {*}       [args.excludeId]      folder _id to exclude (the item being moved)
 * @returns {Promise<string>}
 */
const resolveAvailableFolderName = async ({
  folderName, projectId, parentFolderId, createdBy, excludeId,
}) => {
  const trimmed = String(folderName || '').trim();
  if (!trimmed) return trimmed;

  // Folders have no extension — splitName still works (ext === '').
  const { stem, ext } = splitName(trimmed);
  const filters = {
    project_id: projectId,
    parent_folder_id: parentFolderId || null,
    created_by: createdBy,
    deleted_on: 0,
    folder_name: { $regex: familyRegex(stem, ext) },
  };
  if (excludeId) filters._id = { $ne: excludeId };

  const existing = await DriveFolderRepository.getFolders({ filters, sort: { _id: 1 } });
  const takenLower = new Set(
    existing.map((f) => String(f?.folder_name || '').trim().toLowerCase()),
  );

  const free = pickFreeName(trimmed, takenLower);
  if (!free) throw new BadRequest('too_many_duplicate_folder_names');
  return free;
};

export default {
  resolveAvailableFileName,
  resolveAvailableFolderName,
};
