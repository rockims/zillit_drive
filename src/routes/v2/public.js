import express from 'express';
import joiValidator from 'zillit-libs/middlewares-v2/joi-validator';
import DriveFileShare from '../../controllers/v2/driveFileShare.js';
import driveFileShareValidators from '../../validators/v2/driveFileShare.js';

const router = express.Router();

// Access shared file (public endpoint - no authentication required)
router.get('/files/:shareToken', 
  joiValidator(driveFileShareValidators.accessSharedFile, 'query'), 
  DriveFileShare.accessSharedFile
);

export default router;
