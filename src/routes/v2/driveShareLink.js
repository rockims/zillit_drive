import express from 'express';
import moduleData from 'zillit-libs/middlewares-v2/module-data';
import checkAccess from 'zillit-libs/middlewares-v2/check-access';
import joiValidator from 'zillit-libs/middlewares-v2/joi-validator';
import objectIdValidator from 'zillit-libs/middlewares-v2/objectid-validator';
import viewingAccess from 'zillit-libs/middlewares-v2/viewing-access';
import postingAccess from 'zillit-libs/middlewares-v2/posting-access';

import DriveShareLinkController from '../../controllers/v2/driveShareLink.js';
import driveShareLinkValidators from '../../validators/v2/driveShareLink.js';

const router = express.Router();
const moduledata = moduleData(['device_id', 'project_id', 'user_id']);
const driveViewAccess = viewingAccess('tools_section', null, 'drive_tool');
const drivePostAccess = postingAccess('tools_section', null, 'drive_tool');

// ───── Authenticated endpoints ─────────────────────────────────────────
//
// NB: path uses `email-share-link*` (not `share-link*`) to avoid colliding
// with the existing `POST /files/:fileId/share-link` route in driveFile.js,
// which generates a short-lived S3 presigned URL ("share via copy link").
// That handler is mounted at /drive/files BEFORE this router and would
// otherwise shadow ours — silently returning a presigned URL on every
// share-via-email call.

// Create a share link on a file. Sends emails to listed recipients (if any)
// and returns the link + per-recipient URLs for copy-paste.
router.post(
  '/files/:fileId/email-share-link',
  objectIdValidator(['fileId']),
  moduledata,
  checkAccess,
  drivePostAccess,
  joiValidator(driveShareLinkValidators.createShareLink),
  DriveShareLinkController.createShareLink,
);

// List all active (not revoked) share links for a file. Used by the
// ShareDrawer "Active links" tab so the creator can see / revoke them.
router.get(
  '/files/:fileId/email-share-links',
  objectIdValidator(['fileId']),
  moduledata,
  checkAccess,
  driveViewAccess,
  DriveShareLinkController.listShareLinks,
);

// Revoke a specific share link. Only the link's creator or a user with
// edit permission on the underlying file can revoke.
router.post(
  '/email-share-links/:linkId/revoke',
  objectIdValidator(['linkId']),
  moduledata,
  checkAccess,
  drivePostAccess,
  DriveShareLinkController.revokeShareLink,
);

export default router;
