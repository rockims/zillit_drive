import express from 'express';
import moduleData from 'zillit-libs/middlewares-v2/module-data';
import checkAccess from 'zillit-libs/middlewares-v2/check-access';
import viewingAccess from 'zillit-libs/middlewares-v2/viewing-access';
import postingAccess from 'zillit-libs/middlewares-v2/posting-access';
import objectIdValidator from 'zillit-libs/middlewares-v2/objectid-validator';

import DriveVersion from '../../controllers/v2/driveVersion.js';

const router = express.Router();
const moduledata = moduleData(['device_id', 'project_id', 'user_id']);
const driveViewAccess = viewingAccess('tools_section', null, 'drive_tool');
const drivePostAccess = postingAccess('tools_section', null, 'drive_tool');

// Every service method below also checks the caller's access to the file.

// List all versions of a file (flat, newest first)
router.get(
  '/:fileId',
  objectIdValidator(['fileId']),
  moduledata,
  checkAccess,
  driveViewAccess,
  DriveVersion.listVersions,
);

// Version history grouped into editing sessions, for the history panel
router.get(
  '/:fileId/history',
  objectIdValidator(['fileId']),
  moduledata,
  checkAccess,
  driveViewAccess,
  DriveVersion.getHistory,
);

// What changed in a version compared with the one before
router.get(
  '/:fileId/:versionId/changes',
  objectIdValidator(['fileId', 'versionId']),
  moduledata,
  checkAccess,
  driveViewAccess,
  DriveVersion.getVersionChanges,
);

// Editor config to open a version read-only
router.get(
  '/:fileId/:versionId/preview',
  objectIdValidator(['fileId', 'versionId']),
  moduledata,
  checkAccess,
  driveViewAccess,
  DriveVersion.getVersionPreviewConfig,
);

// Get presigned download URL for a specific version
router.get(
  '/:fileId/:versionId/download',
  objectIdValidator(['fileId', 'versionId']),
  moduledata,
  checkAccess,
  driveViewAccess,
  DriveVersion.getVersionDownloadUrl,
);

// Name a version ("Final budget v2"); an empty name clears it
router.patch(
  '/:fileId/:versionId',
  objectIdValidator(['fileId', 'versionId']),
  moduledata,
  checkAccess,
  drivePostAccess,
  DriveVersion.renameVersion,
);

// Restore a specific version (makes it the current file)
router.post(
  '/:fileId/:versionId/restore',
  objectIdValidator(['fileId', 'versionId']),
  moduledata,
  checkAccess,
  drivePostAccess,
  DriveVersion.restoreVersion,
);

export default router;
