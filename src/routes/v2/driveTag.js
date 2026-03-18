import express from 'express';
import moduleData from 'zillit-libs/middlewares-v2/module-data';
import checkAccess from 'zillit-libs/middlewares-v2/check-access';
import viewingAccess from 'zillit-libs/middlewares-v2/viewing-access';
import postingAccess from 'zillit-libs/middlewares-v2/posting-access';
import objectIdValidator from 'zillit-libs/middlewares-v2/objectid-validator';

import DriveTag from '../../controllers/v2/driveTag.js';

const router = express.Router();
const moduledata = moduleData(['device_id', 'project_id', 'user_id']);
const driveViewAccess = viewingAccess('tools_section', null, 'drive_tool');
const drivePostAccess = postingAccess('tools_section', null, 'drive_tool');

// ── Tag CRUD ──

// Create a tag
router.post('/', moduledata, checkAccess, drivePostAccess, DriveTag.createTag);

// Get all tags for the project
router.get('/', moduledata, checkAccess, driveViewAccess, DriveTag.getTags);

// Update a tag
router.put(
  '/:tagId',
  objectIdValidator(['tagId']),
  moduledata,
  checkAccess,
  drivePostAccess,
  DriveTag.updateTag,
);

// Delete a tag (soft delete)
router.delete(
  '/:tagId',
  objectIdValidator(['tagId']),
  moduledata,
  checkAccess,
  drivePostAccess,
  DriveTag.deleteTag,
);

// ── Tag Assignment ──

// Assign a tag to a file/folder
router.post('/assign', moduledata, checkAccess, drivePostAccess, DriveTag.assignTag);

// Remove a tag from a file/folder
router.post('/remove', moduledata, checkAccess, drivePostAccess, DriveTag.removeTag);

// ── Tag Queries ──

// Get all tags for a specific item (?item_id=xxx&item_type=file)
router.get('/item-tags', moduledata, checkAccess, driveViewAccess, DriveTag.getItemTags);

// Get all items with a specific tag (?tag_id=xxx&item_type=file)
router.get('/items-by-tag', moduledata, checkAccess, driveViewAccess, DriveTag.getItemsByTag);

export default router;
