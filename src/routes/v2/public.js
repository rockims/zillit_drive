import express from 'express';
import driveFileController from '../../controllers/v2/driveFile.js';
import fileProxyController from '../../controllers/v2/fileProxy.js';

const router = express.Router();

// Public file access routes (no authentication required)
router.get('/:token', driveFileController.getPublicFile);

// Public file content streaming (actual file download)
router.get('/:token/content', fileProxyController.getPublicFileContent);

export default router;