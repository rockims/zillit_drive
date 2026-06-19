import express from 'express';
import moduleData from 'zillit-libs/middlewares-v2/module-data';
import checkAccess from 'zillit-libs/middlewares-v2/check-access';
import joiValidator from 'zillit-libs/middlewares-v2/joi-validator';
import postingAccess from 'zillit-libs/middlewares-v2/posting-access';
import viewingAccess from 'zillit-libs/middlewares-v2/viewing-access';

import DriveBulk from '../../controllers/v2/driveBulk.js';
import DriveShareLinkController from '../../controllers/v2/driveShareLink.js';
import driveShareLinkValidators from '../../validators/v2/driveShareLink.js';

const router = express.Router();
const moduledata = moduleData(['device_id', 'project_id', 'user_id']);
const driveViewAccess = viewingAccess('tools_section', null, 'drive_tool');
const drivePostAccess = postingAccess('tools_section', null, 'drive_tool');

// Bulk delete
router.post('/delete', moduledata, checkAccess, drivePostAccess, DriveBulk.bulkDelete);

// Bulk move
router.post('/move', moduledata, checkAccess, drivePostAccess, DriveBulk.bulkMove);

// Bulk download URLs
// `/download` is the canonical path used by iOS; `/download-urls` kept for any caller already using it.
router.post('/download', moduledata, checkAccess, driveViewAccess, DriveBulk.bulkDownloadUrls);
router.post('/download-urls', moduledata, checkAccess, driveViewAccess, DriveBulk.bulkDownloadUrls);

// Bulk download as ZIP (streams)
router.post('/download-zip', moduledata, checkAccess, driveViewAccess, DriveBulk.bulkDownloadZip);

// Bulk favorite — add / remove / toggle starred on many files+folders
// in one call. Body: { items: [{ id, type }], mode?: 'add'|'remove'|'toggle' }.
router.post('/favorite', moduledata, checkAccess, drivePostAccess, DriveBulk.bulkFavorite);

// Bulk share — apply the same access list to many files+folders. Body:
// { items: [{ id, type }], entries: [{ user_id, can_view, can_edit,
// can_download, role? }], replace_existing?: boolean }. Files use the
// boolean perms; folders use `role` (or derive from can_edit).
router.post('/share', moduledata, checkAccess, drivePostAccess, DriveBulk.bulkShare);

// Bulk email-share-link — generate N share links (one per file) and
// send ONE consolidated email per recipient containing links to all
// of them. Body: { file_ids: [], recipients: [{email}], permission,
// expires_in_ms, max_views, message }. Per-recipient watermark tokens
// remain per-file. Validator caps at 100 files + 50 recipients.
// Handler lives in DriveShareLinkController so the link-creation
// logic stays colocated with the rest of the share-link code.
router.post(
  '/email-share-link',
  moduledata,
  checkAccess,
  drivePostAccess,
  joiValidator(driveShareLinkValidators.bulkCreateShareLinks),
  DriveShareLinkController.bulkCreateShareLinks,
);

export default router;
