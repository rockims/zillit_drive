import express from 'express';
import moduleData from 'zillit-libs/middlewares-v2/module-data';
import checkAccess from 'zillit-libs/middlewares-v2/check-access';
import joiValidator from 'zillit-libs/middlewares-v2/joi-validator';
import objectIdValidator from 'zillit-libs/middlewares-v2/objectid-validator';
import postingAccess from 'zillit-libs/middlewares-v2/posting-access';

import DriveUpload from '../../controllers/v2/driveUpload.js';
import driveUploadValidators from '../../validators/v2/driveUpload.js';

const router = express.Router();
const moduledata = moduleData(['device_id', 'project_id', 'user_id']);
const drivePostAccess = postingAccess('tools_section', null, 'drive_tool');

// Initiate a new multipart upload — returns presigned URLs
router.post(
  '/',
  moduledata,
  checkAccess,
  drivePostAccess,
  joiValidator(driveUploadValidators.initiateUpload),
  DriveUpload.initiateUpload,
);

// Complete the multipart upload — assembles file on S3, creates DriveFile record
router.post(
  '/:uploadId/complete',
  objectIdValidator(['uploadId']),
  moduledata,
  checkAccess,
  drivePostAccess,
  joiValidator(driveUploadValidators.completeUpload),
  DriveUpload.completeUpload,
);

// Abort the multipart upload — cancels S3 upload, marks session aborted
router.delete(
  '/:uploadId',
  objectIdValidator(['uploadId']),
  moduledata,
  checkAccess,
  drivePostAccess,
  DriveUpload.abortUpload,
);

// Get presigned URLs for remaining parts (for resuming uploads)
router.get(
  '/:uploadId/parts',
  objectIdValidator(['uploadId']),
  moduledata,
  checkAccess,
  drivePostAccess,
  DriveUpload.getUploadParts,
);

// Get active upload sessions for the current user
router.get(
  '/',
  moduledata,
  checkAccess,
  drivePostAccess,
  DriveUpload.getActiveSessions,
);

export default router;
