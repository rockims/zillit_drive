import express from 'express';
import moduleData from 'zillit-libs/middlewares-v2/module-data';
import checkAccess from 'zillit-libs/middlewares-v2/check-access';
import postingAccess from 'zillit-libs/middlewares-v2/posting-access';
import viewingAccess from 'zillit-libs/middlewares-v2/viewing-access';

import DriveBulk from '../../controllers/v2/driveBulk.js';

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

export default router;
