import BadRequest from 'zillit-libs/errors/BadRequest';
import Forbidden from 'zillit-libs/errors/Forbidden';
import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFolderRepository from '../../repositories/v2/driveFolder.js';
import DriveFileAccessService from './driveFileAccess.js';
import DriveNotificationReceivers from './driveNotificationReceivers.js';
import socketClient from '../../config/socketClient.js';

/**
 * "Let others know you updated this file?"
 *
 * A save never notifies anyone: the editor autosaves every few minutes,
 * so that would be a notification per autosave. Instead the person who
 * edited decides, when they close the file, whether to tell everyone with
 * access, and can add a note. It goes out right away.
 *
 * It is the existing `drive_file_updated` notification with its own
 * message, so web and mobile show it (badge, list entry, push) with no
 * change on their side.
 */

const DRIVE_UNIT_FILE = 'drive_file_label';
const ACTION = 'drive_file_updated';
const NOTE_MAX_LENGTH = 300;
// One announcement per person per file in this window: a double click, or
// someone leaning on the button, is not several notifications.
const MIN_GAP_MS = Number(process.env.DRIVE_EDIT_ANNOUNCE_MIN_GAP_MS) || 60 * 1000;
const REMEMBERED = 5000;

const lastSentAt = new Map();

const toIdString = (value) => (value ? value.toString() : null);

// One line, no control characters, no longer than a notification can show.
const cleanNote = (note) => String(note ?? '')
  .replace(/[\u0000-\u001f\u007f]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, NOTE_MAX_LENGTH);

const messageFor = ({ userName, fileName, note }) => (
  `${userName} updated "${fileName}"${note ? `: ${note}` : ''}`
);

const tooSoon = (key, now) => {
  const previous = lastSentAt.get(key);
  return previous !== undefined && now - previous < MIN_GAP_MS;
};

const remember = (key, now) => {
  // Re-inserting keeps the map in "oldest first" order for the trim below.
  lastSentAt.delete(key);
  lastSentAt.set(key, now);
  if (lastSentAt.size > REMEMBERED) lastSentAt.delete(lastSentAt.keys().next().value);
};

/**
 * Everyone who can see the file, except the person announcing: the people
 * it is shared with (directly or through its folder), plus the file's and
 * the folder's owners, who have no access record of their own.
 */
const receiversFor = async ({
  project, user, file, folder,
}) => {
  const actorId = toIdString(user._id);
  const shared = await DriveNotificationReceivers.getFileReceivers({
    project,
    actorId: user._id,
    fileId: file._id,
    folderId: file.folder_id,
  });
  const owners = [file.created_by, file.uploaded_by, folder?.created_by]
    .map(toIdString)
    .filter((id) => id && id !== actorId);
  return [...new Set([...shared, ...owners])];
};

/**
 * POST /editor/:fileId/announce  { note? }
 */
const announce = async ({
  user, project, params, body = {},
}) => {
  const file = await DriveFileRepository.getFile({
    filters: { _id: params.fileId, project_id: project._id, deleted_on: 0 },
  });
  if (!file) throw new BadRequest('file_not_found');

  // Only someone who can edit the file can say they updated it.
  const permissions = await DriveFileAccessService.resolveFilePermission({ user, project, file });
  if (!permissions || !permissions.can_view) throw new Forbidden('insufficient_permissions');
  if (!permissions.can_edit) throw new Forbidden('no_edit_permission');

  const key = `${toIdString(user._id)}:${toIdString(file._id)}`;
  const now = Date.now();
  if (tooSoon(key, now)) throw new BadRequest('drive_edit_announce_too_soon');

  const folder = file.folder_id
    ? await DriveFolderRepository.getFolder({
      filters: { _id: file.folder_id, project_id: project._id, deleted_on: 0 },
    })
    : null;
  const receiverIds = await receiversFor({
    project, user, file, folder,
  });
  if (receiverIds.length === 0) return { notified: 0 };

  const note = cleanNote(body.note);
  await DriveNotificationReceivers.notifyAllTabRouted({
    project,
    actor: user,
    receiverIds,
    parentFolderOwnerId: folder?.created_by || null,
    folderId: file.folder_id,
    itemId: file._id,
    unit: DRIVE_UNIT_FILE,
    action: ACTION,
    message: messageFor({
      userName: user.full_name || user.name || 'Someone',
      fileName: file.file_name,
      note,
    }),
    referenceData: {
      file_id: toIdString(file._id),
      file_name: file.file_name,
      folder_id: file.folder_id ? toIdString(file.folder_id) : null,
      announced_by_editor: true,
      note,
    },
    socketClient,
  });
  remember(key, now);
  console.log(`[drive_edit_announced] file=${file._id} by=${user._id} receivers=${receiverIds.length} note=${note ? 'yes' : 'no'}`);

  return { notified: receiverIds.length };
};

// Tests start from a clean slate.
const resetForTests = () => lastSentAt.clear();

export {
  NOTE_MAX_LENGTH,
  cleanNote,
  messageFor,
  receiversFor,
  resetForTests,
};

export default { announce };
