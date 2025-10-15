import express from 'express';

import health from './health';
import driveFolder from './driveFolder.js';
import driveFile from './driveFile.js';

const router = express.Router();

router.use('/health', health);
router.use('/drive/folders', driveFolder);
router.use('/drive/files', driveFile);

export default router;
