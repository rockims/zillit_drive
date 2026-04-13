import express from 'express';
import moduleData from 'zillit-libs/middlewares-v2/module-data';
import checkAccess from 'zillit-libs/middlewares-v2/check-access';
import viewingAccess from 'zillit-libs/middlewares-v2/viewing-access';
import postingAccess from 'zillit-libs/middlewares-v2/posting-access';
import objectIdValidator from 'zillit-libs/middlewares-v2/objectid-validator';

import DriveTrash from '../../controllers/v2/driveTrash.js';

const router = express.Router();
const moduledata = moduleData(['device_id', 'project_id', 'user_id']);
const driveViewAccess = viewingAccess('tools_section', null, 'drive_tool');
const drivePostAccess = postingAccess('tools_section', null, 'drive_tool');

// List trashed items
router.get('/', moduledata, checkAccess, driveViewAccess, DriveTrash.listTrash);

// Restore a trashed item (file or folder)
router.post(
  '/:type/:itemId/restore',
  objectIdValidator(['itemId']),
  moduledata,
  checkAccess,
  drivePostAccess,
  DriveTrash.restoreItem,
);

// Permanently delete a trashed item
router.delete(
  '/:type/:itemId',
  objectIdValidator(['itemId']),
  moduledata,
  checkAccess,
  drivePostAccess,
  DriveTrash.permanentDelete,
);

// Empty entire trash
router.delete('/', moduledata, checkAccess, drivePostAccess, DriveTrash.emptyTrash);

export default router;
