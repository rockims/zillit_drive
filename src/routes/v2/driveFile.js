import express from 'express';
import moduleData from 'zillit-libs/middlewares-v2/module-data';
import checkAccess from 'zillit-libs/middlewares-v2/check-access';
import joiValidator from 'zillit-libs/middlewares-v2/joi-validator';
import objectIdValidator from 'zillit-libs/middlewares-v2/objectid-validator';
import viewingAccess from 'zillit-libs/middlewares-v2/viewing-access';
import postingAccess from 'zillit-libs/middlewares-v2/posting-access';

import DriveFile from '../../controllers/v2/driveFile.js';
import driveFileValidators from '../../validators/v2/driveFile.js';

const router = express.Router();
const moduledata = moduleData(['device_id', 'project_id', 'user_id']);
const driveViewAccess = viewingAccess('tools_section', null, 'drive_tool');
const drivePostAccess = postingAccess('tools_section', null, 'drive_tool');

// A text file's content arrives as the request body. It is moved off
// req.body so the request logger never prints whole documents.
const textBody = [
  express.text({ type: 'text/*', limit: '3mb' }),
  (req, res, next) => {
    if (typeof req.body === 'string') req.textBody = req.body;
    else if (Number(req.headers['content-length']) === 0) req.textBody = '';
    req.body = {};
    next();
  },
];

// Get files by type (must come before parameterized routes)
router.get('/by-type', moduledata, checkAccess, driveViewAccess, DriveFile.getFilesByType);

// Create file
router.post('/', moduledata, checkAccess, drivePostAccess, joiValidator(driveFileValidators.createFile), DriveFile.createFile);

// Get all files (can filter by folder_id, file_type, etc. via query params)
router.get('/', moduledata, checkAccess, driveViewAccess, DriveFile.getFiles);

// Get specific file by ID
router.get('/:fileId', objectIdValidator(['fileId']), moduledata, checkAccess, driveViewAccess, DriveFile.getFile);

// Get presigned stream/download URL for a file (video streaming, file download)
router.get('/:fileId/stream', objectIdValidator(['fileId']), moduledata, checkAccess, driveViewAccess, DriveFile.getFileStreamUrl);

// Get presigned preview URL (only requires view permission, not download)
router.get('/:fileId/preview', objectIdValidator(['fileId']), moduledata, checkAccess, driveViewAccess, DriveFile.getFilePreviewUrl);

// Read a Markdown file's text, or a saved version's with ?version_id= (view permission)
router.get('/:fileId/text', objectIdValidator(['fileId']), moduledata, checkAccess, driveViewAccess, DriveFile.getFileText);

// Save a Markdown file's text as a new version (edit permission)
router.put('/:fileId/text', textBody, objectIdValidator(['fileId']), moduledata, checkAccess, drivePostAccess, DriveFile.saveFileText);

// Update file
router.put('/:fileId', objectIdValidator(['fileId']), moduledata, checkAccess, drivePostAccess, joiValidator(driveFileValidators.updateFile), DriveFile.updateFile);

// Move file to different folder
router.put('/:fileId/move', objectIdValidator(['fileId']), moduledata, checkAccess, drivePostAccess, joiValidator(driveFileValidators.moveFile), DriveFile.moveFile);

// Generate shareable link
router.post('/:fileId/share-link', objectIdValidator(['fileId']), moduledata, checkAccess, driveViewAccess, DriveFile.generateShareLink);

// Delete file
router.delete('/:fileId', objectIdValidator(['fileId']), moduledata, checkAccess, drivePostAccess, DriveFile.deleteFile);

export default router;
