import express from 'express';

import health from './health';
import driveFolder from './driveFolder.js';
import driveFile from './driveFile.js';
import driveUpload from './driveUpload.js';
import driveTrash from './driveTrash.js';
import driveStorage from './driveStorage.js';
import driveFavorite from './driveFavorite.js';
import driveActivity from './driveActivity.js';
import driveBulk from './driveBulk.js';
import driveComment from './driveComment.js';
import driveTag from './driveTag.js';
import driveVersion from './driveVersion.js';
import driveFileAccess from './driveFileAccess.js';
import driveEditor from './driveEditor.js';
import driveWopi from './driveWopi.js';
import driveProjectUsers from './driveProjectUsers.js';

const router = express.Router();

router.use('/health', health);
router.use('/drive/folders', driveFolder);
router.use('/drive/files', driveFile);
router.use('/drive/uploads', driveUpload);
router.use('/drive/trash', driveTrash);
router.use('/drive/storage', driveStorage);
router.use('/drive/favorites', driveFavorite);
router.use('/drive/activity', driveActivity);
router.use('/drive/bulk', driveBulk);
router.use('/drive/comments', driveComment);
router.use('/drive/tags', driveTag);
router.use('/drive/versions', driveVersion);
router.use('/drive/file-access', driveFileAccess);
router.use('/drive/editor', driveEditor);
router.use('/drive/wopi', driveWopi);
router.use('/drive/project-users', driveProjectUsers);

export default router;
