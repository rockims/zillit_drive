import express from 'express';

import Health from '../../../controllers/v2/health';

const router = express.Router();

const healthController = new Health();

router.get('/', healthController.healthCheck);

export default router;
