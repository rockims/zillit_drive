import mongoose from 'mongoose';
import DriveEditPresenceRepository from '../../repositories/v2/driveEditPresence.js';

/**
 * Who has a file open in the editor. The editor's own saves only tell us
 * which session saved; this is how a version can also list the people who
 * were editing alongside.
 *
 * Signals: the editor loading the file (WOPI CheckFileInfo) and the web
 * client's open / heartbeat / close calls.
 */

const PRESENCE_TTL_MS = 24 * 60 * 60 * 1000;
// A heartbeat arrives every 60 s; allow two to be missed before someone
// no longer counts as present.
const SEEN_GRACE_MS = 2 * 60 * 1000;

const isObjectId = (value) => !!value && mongoose.Types.ObjectId.isValid(String(value))
  && String(new mongoose.Types.ObjectId(String(value))) === String(value);

/**
 * Record a presence signal. `state` is open | heartbeat | close | seen.
 * Share-link recipients carry a token instead of a user id and are skipped.
 */
const touch = async ({
  projectId, fileId, userId, canEdit = false, state = 'seen', now = Date.now(),
}) => {
  if (!isObjectId(userId) || !isObjectId(fileId)) return;

  const set = {
    project_id: projectId,
    last_seen_at: now,
    expires_at: new Date(now + PRESENCE_TTL_MS),
  };
  // Only raise can_edit: a later read-only preview must not hide that this
  // person was editing earlier in the window.
  if (canEdit) set.can_edit = true;
  if (state === 'open') {
    set.opened_at = now;
    set.closed_at = 0;
  }
  if (state === 'close') set.closed_at = now;

  const setOnInsert = state === 'open' ? {} : { opened_at: now };
  if (!canEdit) setOnInsert.can_edit = false;

  await DriveEditPresenceRepository.upsertPresence({
    fileId, userId, set, setOnInsert,
  });
};

/**
 * Everyone who was editing the file between `since` and now, plus `include`
 * (the person saving). Returns user id strings, saver first.
 */
const editorsSince = async ({ fileId, since, include = null }) => {
  const rows = await DriveEditPresenceRepository.getPresence({
    filters: {
      file_id: fileId,
      can_edit: true,
      last_seen_at: { $gte: (since || 0) - SEEN_GRACE_MS },
    },
  });
  const ids = rows.map((row) => String(row.user_id));
  if (include) ids.unshift(String(include));
  return Array.from(new Set(ids));
};

export default {
  touch,
  editorsSince,
};
