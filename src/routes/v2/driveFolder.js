import express from 'express';
import moduleData from 'zillit-libs/middlewares-v2/module-data';
import checkAccess from 'zillit-libs/middlewares-v2/check-access';
import joiValidator from 'zillit-libs/middlewares-v2/joi-validator';
import objectIdValidator from 'zillit-libs/middlewares-v2/objectid-validator';
import viewingAccess from 'zillit-libs/middlewares-v2/viewing-access';
import postingAccess from 'zillit-libs/middlewares-v2/posting-access';

import DriveFolder from '../../controllers/v2/driveFolder.js';
import driveFolderValidators from '../../validators/v2/driveFolder.js';

const router = express.Router();
const moduledata = moduleData(['device_id', 'project_id', 'user_id']);
const driveViewAccess = viewingAccess('tools_section', null, 'drive_tool');
const drivePostAccess = postingAccess('tools_section', null, 'drive_tool');

// Create folder
router.post('/', moduledata, checkAccess, drivePostAccess, joiValidator(driveFolderValidators.createFolder), DriveFolder.createFolder);

// Get all folders (can filter by parent_folder_id via query params)
router.get('/', moduledata, checkAccess, driveViewAccess, DriveFolder.getFolders);

// Get combined folder + file contents with server-side sort/filter/group/pagination
router.get('/contents', moduledata, checkAccess, driveViewAccess, DriveFolder.getDriveContents);

// Get specific folder by ID
router.get('/:folderId', objectIdValidator(['folderId']), moduledata, checkAccess, driveViewAccess, DriveFolder.getFolder);

// Get folder contents (subfolders and files)
router.get('/:folderId/contents', objectIdValidator(['folderId']), moduledata, checkAccess, driveViewAccess, DriveFolder.getFolderContents);

// Get folder access list
router.get('/:folderId/access', objectIdValidator(['folderId']), moduledata, checkAccess, driveViewAccess, DriveFolder.getFolderAccess);

// Update folder access list
router.put(
  '/:folderId/access',
  objectIdValidator(['folderId']),
  moduledata,
  checkAccess,
  drivePostAccess,
  joiValidator(driveFolderValidators.updateFolderAccess),
  DriveFolder.updateFolderAccess
);

// Inherit folder access to descendants
router.post(
  '/:folderId/access/inherit',
  objectIdValidator(['folderId']),
  moduledata,
  checkAccess,
  drivePostAccess,
  joiValidator(driveFolderValidators.inheritFolderAccess),
  DriveFolder.inheritFolderAccess
);

// Move folder to different parent
router.put('/:folderId/move', objectIdValidator(['folderId']), moduledata, checkAccess, drivePostAccess, joiValidator(driveFolderValidators.moveFolder), DriveFolder.moveFolder);

// Update folder
router.put('/:folderId', objectIdValidator(['folderId']), moduledata, checkAccess, drivePostAccess, joiValidator(driveFolderValidators.updateFolder), DriveFolder.updateFolder);

// Delete folder
router.delete('/:folderId', objectIdValidator(['folderId']), moduledata, checkAccess, drivePostAccess, DriveFolder.deleteFolder);

export default router;
