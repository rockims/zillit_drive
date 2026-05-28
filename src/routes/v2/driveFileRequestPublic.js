import express from 'express';

import DriveFileRequestController from '../../controllers/v2/driveFileRequest.js';

// Public (no-auth) file request routes. URL token is the credential —
// these intentionally skip moduledata / checkAccess. All three pass
// through validatePublicToken in the service for revoked / expired
// gates.
const router = express.Router();

// Viewer page metadata for the upload UI.
router.get('/request/:token', DriveFileRequestController.getRequestViewerData);

// Start an upload session — recipient enters email/name (if required)
// and gets back a session_id to attribute subsequent uploads to.
router.post('/request/:token/upload-session', DriveFileRequestController.startUploadSession);

// Receive a single uploaded file. The GLOBAL express-fileupload
// middleware (app.js) already parses the multipart body and exposes
// the file at req.files.file — applying a second fileUpload() here
// would run busboy on an already-drained stream and throw
// "Unexpected end of form". Per-request gates (allowed mime, size,
// max files per session) are checked in the service against the
// loaded request doc.
router.post(
  '/request/:token/upload',
  DriveFileRequestController.receiveUpload,
);

export default router;
