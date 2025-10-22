import express from 'express';

import health from './health';
import driveFolder from './driveFolder.js';
import driveFile from './driveFile.js';
import publicRoutes from './public.js';

const router = express.Router();

router.use('/health', health);
router.use('/drive/folders', driveFolder);
router.use('/drive/files', driveFile);
router.use('/public', publicRoutes);

export default router;
