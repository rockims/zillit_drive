import express from 'express';
import moduleData from 'zillit-libs/middlewares-v2/module-data';
import checkAccess from 'zillit-libs/middlewares-v2/check-access';
import viewingAccess from 'zillit-libs/middlewares-v2/viewing-access';

import DriveActivity from '../../controllers/v2/driveActivity.js';

const router = express.Router();
const moduledata = moduleData(['device_id', 'project_id', 'user_id']);
const driveViewAccess = viewingAccess('tools_section', null, 'drive_tool');

// Get activity log (supports ?item_id=, ?user_id=, ?action=)
router.get('/', moduledata, checkAccess, driveViewAccess, DriveActivity.getActivity);

export default router;
