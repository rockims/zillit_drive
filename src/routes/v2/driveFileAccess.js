import express from 'express';
import moduleData from 'zillit-libs/middlewares-v2/module-data';
import checkAccess from 'zillit-libs/middlewares-v2/check-access';
import joiValidator from 'zillit-libs/middlewares-v2/joi-validator';
import objectIdValidator from 'zillit-libs/middlewares-v2/objectid-validator';
import viewingAccess from 'zillit-libs/middlewares-v2/viewing-access';
import postingAccess from 'zillit-libs/middlewares-v2/posting-access';

import DriveFileAccess from '../../controllers/v2/driveFileAccess.js';
import driveFileAccessValidators from '../../validators/v2/driveFileAccess.js';

const router = express.Router();
const moduledata = moduleData(['device_id', 'project_id', 'user_id']);
const driveViewAccess = viewingAccess('tools_section', null, 'drive_tool');
const drivePostAccess = postingAccess('tools_section', null, 'drive_tool');

// Get file access list
router.get(
  '/:fileId/access',
  objectIdValidator(['fileId']),
  moduledata,
  checkAccess,
  driveViewAccess,
  DriveFileAccess.getFileAccess,
);

// Update file access list
router.put(
  '/:fileId/access',
  objectIdValidator(['fileId']),
  moduledata,
  checkAccess,
  drivePostAccess,
  joiValidator(driveFileAccessValidators.updateFileAccess),
  DriveFileAccess.updateFileAccess,
);

export default router;
