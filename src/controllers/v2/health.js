// import cluster from 'cluster';
import { httpStatusCodes } from 'zillit-libs/config';

class Health {
  constructor() {
    this.version = 2;
  }

  healthCheck = (_req, resp) => resp.status(httpStatusCodes.OK).send({
    message: 'V2 Ok',
    data: {
      process_id: process.pid,
      uptime: process.uptime(),
      // workerId: cluster?.worker?.id,
    },
  });
}

export default Health;
