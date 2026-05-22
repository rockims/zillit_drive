import express from 'express';

import DriveShareLinkController from '../../controllers/v2/driveShareLink.js';

// Public (no-auth) share-link routes. These intentionally skip moduledata
// / checkAccess / viewing-access — the URL token IS the credential.
//
// All three endpoints route through validatePublicToken in the service so
// every call enforces:
//   - link exists & not revoked
//   - not expired
//   - max_views not exceeded
//
// The recipient_token (?r=<token>) is optional but recommended — when
// present we attribute the view to a specific recipient for forensic
// trace; when missing we still bump the top-level counter.
const router = express.Router();

// Viewer page metadata: file info + permission flags + watermark text.
// Does NOT return a stream URL — that's a separate call so the URL stays
// fresh on each load (5-min TTL).
router.get('/share/:token', DriveShareLinkController.getViewerData);

// Short-lived presigned S3 GET URL for the underlying media. Records the
// view (counts against max_views, logs recipient + IP + UA).
router.get('/share/:token/stream', DriveShareLinkController.getStreamUrl);

// Lightweight ping for the viewer to call on page load (separate from
// /stream so analytics events don't consume presigned URL allocations).
router.post('/share/:token/view', DriveShareLinkController.recordView);

export default router;
