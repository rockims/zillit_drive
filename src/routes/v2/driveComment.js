import express from 'express';
import moduleData from 'zillit-libs/middlewares-v2/module-data';
import checkAccess from 'zillit-libs/middlewares-v2/check-access';
import viewingAccess from 'zillit-libs/middlewares-v2/viewing-access';
import postingAccess from 'zillit-libs/middlewares-v2/posting-access';
import objectIdValidator from 'zillit-libs/middlewares-v2/objectid-validator';

import DriveComment from '../../controllers/v2/driveComment.js';

const router = express.Router();
const moduledata = moduleData(['device_id', 'project_id', 'user_id']);
const driveViewAccess = viewingAccess('tools_section', null, 'drive_tool');
const drivePostAccess = postingAccess('tools_section', null, 'drive_tool');

// Get comments for a file (?file_id=xxx)
router.get('/', moduledata, checkAccess, driveViewAccess, DriveComment.getComments);

// Add a comment
router.post('/', moduledata, checkAccess, drivePostAccess, DriveComment.addComment);

// Update a comment
router.put('/:commentId', objectIdValidator(['commentId']), moduledata, checkAccess, drivePostAccess, DriveComment.updateComment);

// Delete a comment
router.delete('/:commentId', objectIdValidator(['commentId']), moduledata, checkAccess, drivePostAccess, DriveComment.deleteComment);

export default router;
