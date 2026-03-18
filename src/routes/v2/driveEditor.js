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
 * Browser-facing — full middleware chain for authentication.
 * Returns OnlyOffice editor config for the given file.
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
 * Authenticated — mobile app calls this to get a short-lived JWT
 * for loading the editor page in a WebView.
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
 * Token-authenticated — WebView loads this URL directly.
 * Auth is via short-lived JWT in query string (no middleware needed).
 */
router.get(
  '/:fileId/page',
  DriveEditor.serveEditorPage,
);

/**
 * GET /:fileId/download
 * OnlyOffice server-facing — NO standard middleware.
 * Proxies the document from S3 to OnlyOffice Document Server.
 * Auth is via HMAC token in query string.
 */
router.get(
  '/:fileId/download',
  DriveEditor.proxyDocumentDownload,
);

/**
 * POST /callback
 * OnlyOffice server-facing — NO standard middleware.
 * OnlyOffice calls this URL when a document is saved.
 * Auth is via JWT verification of the token in the request body.
 */
router.post(
  '/callback',
  DriveEditor.handleEditorCallback,
);

export default router;
