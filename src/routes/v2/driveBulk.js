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
router.post('/download-urls', moduledata, checkAccess, driveViewAccess, DriveBulk.bulkDownloadUrls);

// Bulk download as ZIP (streams)
router.post('/download-zip', moduledata, checkAccess, driveViewAccess, DriveBulk.bulkDownloadZip);

export default router;
