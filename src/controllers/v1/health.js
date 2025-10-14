// import cluster from 'cluster';
import { httpStatusCodes } from 'zillit-libs/config';

class Health {
  constructor() {
    this.version = 1;
  }

  healthCheck = (_req, resp) => resp.status(httpStatusCodes.OK).send({
    message: 'V1 Ok',
    data: {
      process_id: process.pid,
      uptime: process.uptime(),
      // workerId: cluster?.worker?.id,
    },
  });
}

export default Health;
