import express from 'express';
import moduleData from 'zillit-libs/middlewares-v2/module-data';
import checkAccess from 'zillit-libs/middlewares-v2/check-access';
import viewingAccess from 'zillit-libs/middlewares-v2/viewing-access';

import DriveStorage from '../../controllers/v2/driveStorage.js';

const router = express.Router();
const moduledata = moduleData(['device_id', 'project_id', 'user_id']);
const driveViewAccess = viewingAccess('tools_section', null, 'drive_tool');

// Get storage usage statistics
router.get('/', moduledata, checkAccess, driveViewAccess, DriveStorage.getStorageUsage);

export default router;
