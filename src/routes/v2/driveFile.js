import express from 'express';
import moduleData from 'zillit-libs/middlewares-v2/module-data';
import checkAccess from 'zillit-libs/middlewares-v2/check-access';
import joiValidator from 'zillit-libs/middlewares-v2/joi-validator';
import objectIdValidator from 'zillit-libs/middlewares-v2/objectid-validator';

import DriveFile from '../../controllers/v2/driveFile.js';
import driveFileValidators from '../../validators/v2/driveFile.js';

const router = express.Router();
const moduledata = moduleData(['device_id', 'project_id', 'user_id']);

// Get files by type (must come before parameterized routes)
router.get('/by-type', moduledata, checkAccess, DriveFile.getFilesByType);

// Create file
router.post('/', moduledata, checkAccess, joiValidator(driveFileValidators.createFile), DriveFile.createFile);

// Get all files (can filter by folder_id, file_type, etc. via query params)
router.get('/', moduledata, checkAccess, DriveFile.getFiles);

// Get specific file by ID
router.get('/:fileId', objectIdValidator(['fileId']), moduledata, checkAccess, DriveFile.getFile);

// Update file
router.put('/:fileId', objectIdValidator(['fileId']), moduledata, checkAccess, joiValidator(driveFileValidators.updateFile), DriveFile.updateFile);

// Move file to different folder
router.put('/:fileId/move', objectIdValidator(['fileId']), moduledata, checkAccess, joiValidator(driveFileValidators.moveFile), DriveFile.moveFile);

// Delete file
router.delete('/:fileId', objectIdValidator(['fileId']), moduledata, checkAccess, DriveFile.deleteFile);

export default router;
