import express from 'express';
import moduleData from 'zillit-libs/middlewares-v2/module-data';
import checkAccess from 'zillit-libs/middlewares-v2/check-access';
import joiValidator from 'zillit-libs/middlewares-v2/joi-validator';
import objectIdValidator from 'zillit-libs/middlewares-v2/objectid-validator';
import viewingAccess from 'zillit-libs/middlewares-v2/viewing-access';
import postingAccess from 'zillit-libs/middlewares-v2/posting-access';

import DriveFileRequestController from '../../controllers/v2/driveFileRequest.js';
import driveFileRequestValidators from '../../validators/v2/driveFileRequest.js';

const router = express.Router();
const moduledata = moduleData(['device_id', 'project_id', 'user_id']);
const driveViewAccess = viewingAccess('tools_section', null, 'drive_tool');
const drivePostAccess = postingAccess('tools_section', null, 'drive_tool');

// ───── Authenticated endpoints ──────────────────────────────────────
//
// Paths use `file-request*` (with hyphen). Distinct from the existing
// `email-share-link*` namespace and from any other Drive endpoint.

// Create a new file request on a destination folder.
router.post(
  '/file-requests',
  moduledata,
  checkAccess,
  drivePostAccess,
  joiValidator(driveFileRequestValidators.createFileRequest),
  DriveFileRequestController.createFileRequest,
);

// List all active (not revoked) file requests for a folder.
router.get(
  '/folders/:folderId/file-requests',
  objectIdValidator(['folderId']),
  moduledata,
  checkAccess,
  driveViewAccess,
  DriveFileRequestController.listFileRequests,
);

// Revoke a file request. Creator OR anyone with edit access on the
// destination folder can revoke.
router.post(
  '/file-requests/:requestId/revoke',
  objectIdValidator(['requestId']),
  moduledata,
  checkAccess,
  drivePostAccess,
  DriveFileRequestController.revokeFileRequest,
);

export default router;
