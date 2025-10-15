import fs from 'fs';
// import os from 'node:os';
// import cluster from 'node:cluster';
// import { dirname } from 'path';
import process from 'node:process';
import { createServer } from 'node:http';
// import { fileURLToPath } from 'url';

import dotenv from 'dotenv';

import { mongodbConnect } from 'zillit-libs/config';
import app from './app';

// const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config();

process.on('uncaughtException', (error, source) => {
  fs.writeSync(process.stderr.fd, `${error.message}\n`, source);
  console.log('[Exiting uncaughtException]:', error);
  console.error(error.stack);
});

process.on('unhandledRejection', (error) => {
  console.log('[Exiting unhandledRejection]:', error);
});

process.on('SIGINT', () => {
  app.shutdown();
});

process.on('SIGTERM', () => {
  app.shutdown();
});

mongodbConnect(process.env.DB_URL)
  .then(() => {
    const PORT = Number(process.env.PORT) || 3000;

    // Create an Express app and a basic HTTP server
    const server = createServer(app);

    server.listen(PORT, () => {
      const host = server.address().address;
      const { port } = server.address();
      console.log('app listening at http://%s:%s', host, port);
    });
  })
  .catch((error) => {
    console.log(`mongoDbConnect:error: for Process ${process.pid} : `, error.message);
  });
