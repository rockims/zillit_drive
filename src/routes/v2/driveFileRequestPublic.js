import express from 'express';
import fileUpload from 'express-fileupload';

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

// Receive a single uploaded file. express-fileupload parses the
// multipart body and exposes the file at req.files.file. 5 GB cap
// matches max_total_size_bytes ceiling in the validator; per-request
// gates (allowed mime, max files per session) are checked in the
// service against the loaded request doc.
router.post(
  '/request/:token/upload',
  fileUpload({
    limits: { fileSize: 5 * 1024 * 1024 * 1024 },
    useTempFiles: false,                 // keep in memory; recipients send one file at a time
    abortOnLimit: true,
    safeFileNames: true,
    preserveExtension: 16,               // keep up to 16-char extensions
  }),
  DriveFileRequestController.receiveUpload,
);

export default router;
