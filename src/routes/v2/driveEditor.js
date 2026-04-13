import express from 'express';
import moduleData from 'zillit-libs/middlewares-v2/module-data';
import checkAccess from 'zillit-libs/middlewares-v2/check-access';
import objectIdValidator from 'zillit-libs/middlewares-v2/objectid-validator';
import viewingAccess from 'zillit-libs/middlewares-v2/viewing-access';

import DriveEditor from '../../controllers/v2/driveEditor.js';

const router = express.Router();

const moduledata = moduleData(['device_id', 'project_id', 'user_id']);
const driveViewAccess = viewingAccess('tools_section', null, 'drive_tool');

/**
 * GET /:fileId/config
 * Browser-facing — full middleware chain.
 * Returns Collabora editor config (collaboraUrl, wopiSrc, accessToken).
 */
router.get(
  '/:fileId/config',
  objectIdValidator(['fileId']),
  moduledata,
  checkAccess,
  driveViewAccess,
  DriveEditor.getEditorConfig,
);

/**
 * GET /:fileId/page-token
 * Authenticated — mobile app calls this to get a short-lived JWT.
 */
router.get(
  '/:fileId/page-token',
  objectIdValidator(['fileId']),
  moduledata,
  checkAccess,
  driveViewAccess,
  DriveEditor.generateEditorPageToken,
);

/**
 * GET /:fileId/page
 * Token-authenticated — WebView loads this URL.
 * Returns HTML page with Collabora iframe.
 */
router.get(
  '/:fileId/page',
  DriveEditor.serveEditorPage,
);

export default router;
