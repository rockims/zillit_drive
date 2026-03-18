import express from 'express';
import moduleData from 'zillit-libs/middlewares-v2/module-data';
import checkAccess from 'zillit-libs/middlewares-v2/check-access';
import viewingAccess from 'zillit-libs/middlewares-v2/viewing-access';
import postingAccess from 'zillit-libs/middlewares-v2/posting-access';

import DriveFavorite from '../../controllers/v2/driveFavorite.js';

const router = express.Router();
const moduledata = moduleData(['device_id', 'project_id', 'user_id']);
const driveViewAccess = viewingAccess('tools_section', null, 'drive_tool');
const drivePostAccess = postingAccess('tools_section', null, 'drive_tool');

// Toggle favorite on/off
router.post('/toggle', moduledata, checkAccess, drivePostAccess, DriveFavorite.toggleFavorite);

// List user's favorites
router.get('/', moduledata, checkAccess, driveViewAccess, DriveFavorite.listFavorites);

// Get favorite IDs only (lightweight — for star icons in table)
router.get('/ids', moduledata, checkAccess, driveViewAccess, DriveFavorite.getFavoriteIds);

export default router;
