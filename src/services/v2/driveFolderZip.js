import archiver from 'archiver';
import mongoose from 'mongoose';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import BadRequest from 'zillit-libs/errors/BadRequest';
import Forbidden from 'zillit-libs/errors/Forbidden';
import DriveFolderRepository from '../../repositories/v2/driveFolder.js';
import DriveFolderAccessRepository from '../../repositories/v2/driveFolderAccess.js';
import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFileAccessRepository from '../../repositories/v2/driveFileAccess.js';
import DriveAccessService from './driveAccess.js';
import { hasMinRole } from './driveAccessRoles.js';
import { getS3Client, getFileS3Info } from '../../utils/driveS3.js';
import { signAccessToken, verifyAccessToken } from '../../utils/editorJwt.js';

/**
 * Download a folder as a .zip.
 *
 * Owners and editors of the folder only. The browser can't send our auth
 * headers on a plain download, and holding a whole folder in memory as a
 * blob doesn't scale, so it is two steps:
 *
 *   1. POST /folders/:folderId/download-zip  (authenticated) checks the
 *      role and returns a short-lived token.
 *   2. GET  /folders/download-zip?token=…    streams the zip, so the
 *      browser saves it straight to disk.
 *
 * There is no cap on files or bytes. Objects are read from S3 one at a
 * time, so memory stays flat whatever the folder holds; the only guard is
 * how many zips are being built at once (DRIVE_FOLDER_ZIP_MAX_CONCURRENT).
 *
 * A file inside the folder that this person may not download (an explicit
 * file-level restriction, or a sub-folder they only view) is left out and
 * listed in "_skipped.txt" at the top of the zip.
 */

const TOKEN_TYPE = 'folder_zip';
const LINK_TTL_SECONDS = 120;
const MAX_CONCURRENT = Number(process.env.DRIVE_FOLDER_ZIP_MAX_CONCURRENT) || 3;
const MIN_ROLE = 'editor';
const SKIPPED_FILE = '_skipped.txt';
const ID_CHUNK = 5000;

// Already compressed: deflating these again costs CPU and saves nothing.
const STORED_EXTENSIONS = new Set([
  'zip', 'gz', '7z', 'rar', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif',
  'mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm', 'm4v', 'mp3', 'aac', 'flac',
  'ogg', 'm4a', 'mpeg', 'pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp',
]);

const ROLE_CAN_DOWNLOAD = { owner: true, editor: true, viewer: false };

let active = 0;

const toIdString = (value) => (value ? value.toString() : null);
const objectId = (value) => new mongoose.Types.ObjectId(toIdString(value));

/* ───────────── Planning (pure) ───────────── */

// A name that is safe as one path segment on Windows, macOS and Linux.
const safeName = (name, fallback) => {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+$/, '_')
    .trim();
  return cleaned || fallback;
};

// "Budget.xlsx" taken -> "Budget (1).xlsx". Compared case-insensitively,
// because the zip is usually unpacked on Windows or macOS.
const uniqueNamer = () => {
  const taken = new Set();
  return (name) => {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let n = 1; taken.has(candidate.toLowerCase()); n += 1) candidate = `${base} (${n})${ext}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  };
};

/**
 * This person's role on every folder in the tree. Same rule as
 * DriveAccessService.resolveFolderRole: the closest folder with its own
 * access record (or that they created) wins, otherwise the parent's role.
 */
const effectiveRoles = ({ rootId, rootRole, folders, roleByFolderId, userId }) => {
  const childrenOf = new Map();
  folders.forEach((folder) => {
    const parent = toIdString(folder.parent_folder_id);
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(folder);
  });

  const roles = new Map([[toIdString(rootId), rootRole]]);
  const queue = [toIdString(rootId)];
  while (queue.length) {
    const parentId = queue.shift();
    (childrenOf.get(parentId) || []).forEach((folder) => {
      const id = toIdString(folder._id);
      if (roles.has(id)) return;
      const own = roleByFolderId.get(id)
        || (toIdString(folder.created_by) === toIdString(userId) ? 'owner' : null);
      roles.set(id, own || roles.get(parentId));
      queue.push(id);
    });
  }
  return roles;
};

// Same order as DriveFileAccessService.resolveFilePermission.
const mayDownload = ({ file, userId, fileAccessById, roles }) => {
  const user = toIdString(userId);
  if (toIdString(file.created_by) === user || toIdString(file.uploaded_by) === user) return true;
  const explicit = fileAccessById.get(toIdString(file._id));
  if (explicit) return !!explicit.can_view && !!explicit.can_download;
  return !!ROLE_CAN_DOWNLOAD[roles.get(toIdString(file.folder_id))];
};

/**
 * What goes in the zip: every folder as a directory (so empty ones
 * survive), every downloadable file under its folder's path, and the
 * paths that were left out.
 */
const planArchive = ({
  root, rootRole, folders, files, roleByFolderId, fileAccessById, userId,
}) => {
  const rootId = toIdString(root._id);
  const roles = effectiveRoles({
    rootId, rootRole, folders, roleByFolderId, userId,
  });

  const byParent = new Map();
  folders.forEach((folder) => {
    const parent = toIdString(folder.parent_folder_id);
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(folder);
  });
  const filesByFolder = new Map();
  files.forEach((file) => {
    const folderId = toIdString(file.folder_id);
    if (!filesByFolder.has(folderId)) filesByFolder.set(folderId, []);
    filesByFolder.get(folderId).push(file);
  });
  const byName = (key) => (a, b) => String(a[key] || '').localeCompare(String(b[key] || ''));

  const directories = [];
  const entries = [];
  const skipped = [];

  const walk = (folderId, path) => {
    directories.push(`${path}/`);
    const unique = uniqueNamer();
    (byParent.get(folderId) || []).sort(byName('folder_name')).forEach((folder) => {
      const name = unique(safeName(folder.folder_name, 'Folder'));
      walk(toIdString(folder._id), `${path}/${name}`);
    });
    (filesByFolder.get(folderId) || []).sort(byName('file_name')).forEach((file) => {
      const name = `${path}/${unique(safeName(file.file_name, 'file'))}`;
      const { s3Key, bucket, region } = getFileS3Info(file);
      if (!s3Key) skipped.push({ path: name, reason: 'no stored content' });
      else if (!mayDownload({
        file, userId, fileAccessById, roles,
      })) skipped.push({ path: name, reason: 'no download permission' });
      else entries.push({
        name, s3Key, bucket, region,
      });
    });
  };
  walk(rootId, safeName(root.folder_name, 'Folder'));

  return { directories, entries, skipped };
};

/* ───────────── Loading ───────────── */

const inChunks = async (ids, load) => {
  const all = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    all.push(...await load(ids.slice(i, i + ID_CHUNK)));
  }
  return all;
};

const loadFolder = async ({ projectId, folderId }) => {
  const folder = await DriveFolderRepository.getFolder({
    filters: { _id: folderId, project_id: projectId, deleted_on: 0 },
  });
  if (!folder) throw new BadRequest('folder_not_found');
  return folder;
};

const assertMayZip = async ({ user, project, folder }) => {
  const role = await DriveAccessService.resolveFolderRole({ user, project, folder });
  if (!role || !hasMinRole(role, MIN_ROLE)) throw new Forbidden('insufficient_permissions');
  return role;
};

const loadPlan = async ({
  user, project, root, rootRole,
}) => {
  const folderIds = await DriveAccessService.collectDescendantFolderIds({
    projectId: project._id,
    rootFolderId: root._id,
    includeRoot: true,
  });
  const ids = folderIds.map(objectId);
  const rootId = toIdString(root._id);

  const [folders, files, folderAccess] = await Promise.all([
    inChunks(ids, (chunk) => DriveFolderRepository.getFolders({
      filters: { _id: { $in: chunk }, project_id: project._id, deleted_on: 0 },
    })),
    inChunks(ids, (chunk) => DriveFileRepository.getFiles({
      filters: { folder_id: { $in: chunk }, project_id: project._id, deleted_on: 0 },
    })),
    inChunks(ids, (chunk) => DriveFolderAccessRepository.getAccesses({
      filters: {
        project_id: project._id, folder_id: { $in: chunk }, user_id: user._id, deleted_on: 0,
      },
    })),
  ]);
  const fileAccess = await inChunks(files.map((file) => file._id), (chunk) => DriveFileAccessRepository.getAccesses({
    filters: {
      project_id: project._id, file_id: { $in: chunk }, user_id: user._id, deleted_on: 0,
    },
  }));

  return planArchive({
    root,
    rootRole,
    folders: folders.filter((folder) => toIdString(folder._id) !== rootId),
    files,
    roleByFolderId: new Map(folderAccess.map((rec) => [toIdString(rec.folder_id), rec.role])),
    fileAccessById: new Map(fileAccess.map((rec) => [toIdString(rec.file_id), rec])),
    userId: user._id,
  });
};

/* ───────────── Step 1: the link ───────────── */

const createDownloadLink = async ({ user, project, params }) => {
  const folder = await loadFolder({ projectId: project._id, folderId: params.folderId });
  await assertMayZip({ user, project, folder });
  if (active >= MAX_CONCURRENT) throw new BadRequest('drive_zip_busy_try_again');

  const token = signAccessToken({
    type: TOKEN_TYPE,
    folderId: toIdString(folder._id),
    projectId: toIdString(project._id),
    userId: toIdString(user._id),
  }, LINK_TTL_SECONDS);
  return {
    token,
    expires_in_seconds: LINK_TTL_SECONDS,
    file_name: `${safeName(folder.folder_name, 'Folder')}.zip`,
  };
};

/* ───────────── Step 2: the stream ───────────── */

const readToken = (token) => {
  if (!token) throw new BadRequest('missing_download_token');
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw new BadRequest('invalid_or_expired_download_link');
  }
  if (payload.type !== TOKEN_TYPE || !payload.folderId || !payload.projectId || !payload.userId) {
    throw new BadRequest('invalid_or_expired_download_link');
  }
  return payload;
};

// One entry at a time: archiver queues what it is given, so handing it
// every S3 stream up front would hold thousands of idle connections.
const appendAndWait = (archive, source, data) => new Promise((resolve, reject) => {
  function onEntry() {
    archive.off('error', onError);
    resolve();
  }
  function onError(error) {
    archive.off('entry', onEntry);
    reject(error);
  }
  archive.once('entry', onEntry);
  archive.once('error', onError);
  if (typeof source.on === 'function') source.once('error', onError);
  archive.append(source, data);
});

const extensionOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

const contentDisposition = (fileName) => {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
};

const streamZip = async ({ query, res }) => {
  const payload = readToken(query.token);
  const user = { _id: objectId(payload.userId) };
  const project = { _id: objectId(payload.projectId) };

  // The link is short-lived, but access may have changed since it was made.
  const root = await loadFolder({ projectId: project._id, folderId: payload.folderId });
  const rootRole = await assertMayZip({ user, project, folder: root });
  if (active >= MAX_CONCURRENT) throw new BadRequest('drive_zip_busy_try_again');

  active += 1;
  let released = false;
  const release = () => {
    if (!released) { released = true; active -= 1; }
  };

  try {
    const plan = await loadPlan({
      user, project, root, rootRole,
    });
    const zipName = `${safeName(root.folder_name, 'Folder')}.zip`;

    const archive = archiver('zip', { zlib: { level: 5 } });
    let aborted = false;
    res.on('close', () => {
      if (!res.writableEnded) { aborted = true; archive.abort(); }
      release();
    });
    archive.on('warning', (warning) => console.warn(`[folder_zip_warning] ${warning.message}`));

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(zipName));
    res.setHeader('Cache-Control', 'no-store');
    archive.pipe(res);

    const skipped = [...plan.skipped];
    for (const directory of plan.directories) {
      if (aborted) return null;
      await appendAndWait(archive, Buffer.alloc(0), { name: directory });
    }
    for (const entry of plan.entries) {
      if (aborted) return null;
      let body;
      try {
        ({ Body: body } = await getS3Client(entry.region).send(new GetObjectCommand({
          Bucket: entry.bucket, Key: entry.s3Key,
        })));
      } catch (error) {
        console.error(`[folder_zip] could not read ${entry.name}: ${error.message}`);
        skipped.push({ path: entry.name, reason: 'could not be read' });
        continue;
      }
      await appendAndWait(archive, body, {
        name: entry.name,
        store: STORED_EXTENSIONS.has(extensionOf(entry.name)),
      });
    }
    if (skipped.length && !aborted) {
      const text = [
        'These items are not in this download:',
        '',
        ...skipped.map((item) => `${item.path}  (${item.reason})`),
        '',
      ].join('\r\n');
      await appendAndWait(archive, Buffer.from(text, 'utf8'), { name: SKIPPED_FILE });
    }
    if (aborted) return null;

    await archive.finalize();
    console.log(`[folder_zip] folder=${payload.folderId} user=${payload.userId} files=${plan.entries.length} skipped=${skipped.length} bytes=${archive.pointer()}`);
    return null; // response already handled
  } catch (error) {
    // Headers are out once the first bytes are: all we can do is cut the
    // download so the browser reports it as failed.
    if (res.headersSent) {
      console.error(`[folder_zip_failed] folder=${payload.folderId} error=${error.message}`);
      res.destroy(error);
      return null;
    }
    throw error;
  } finally {
    release();
  }
};

export {
  safeName,
  uniqueNamer,
  effectiveRoles,
  mayDownload,
  planArchive,
};

export default {
  createDownloadLink,
  streamZip,
};
