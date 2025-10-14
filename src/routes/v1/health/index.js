import express from 'express';

import Health from '../../../controllers/v1/health';

const router = express.Router();

const healthController = new Health();

router.get('/', healthController.healthCheck);

export default router;
