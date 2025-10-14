import express from 'express';
import moduleData from 'zillit-libs/middlewares-v2/module-data';
import checkAccess from 'zillit-libs/middlewares-v2/check-access';
import joiValidator from 'zillit-libs/middlewares-v2/joi-validator';
import objectIdValidator from 'zillit-libs/middlewares-v2/objectid-validator';

import DriveFolder from '../../controllers/v2/driveFolder.js';
import driveFolderValidators from '../../validators/v2/driveFolder.js';

const router = express.Router();
const moduledata = moduleData(['device_id', 'project_id', 'user_id']);

// Create folder
router.post('/', moduledata, checkAccess, joiValidator(driveFolderValidators.createFolder), DriveFolder.createFolder);

// Get all folders (can filter by parent_folder_id via query params)
router.get('/', moduledata, checkAccess, DriveFolder.getFolders);

// Get specific folder by ID
router.get('/:folderId', objectIdValidator(['folderId']), moduledata, checkAccess, DriveFolder.getFolder);

// Get folder contents (subfolders and files)
router.get('/:folderId/contents', objectIdValidator(['folderId']), moduledata, checkAccess, DriveFolder.getFolderContents);

// Update folder
router.put('/:folderId', objectIdValidator(['folderId']), moduledata, checkAccess, joiValidator(driveFolderValidators.updateFolder), DriveFolder.updateFolder);

// Delete folder
router.delete('/:folderId', objectIdValidator(['folderId']), moduledata, checkAccess, DriveFolder.deleteFolder);

export default router;
