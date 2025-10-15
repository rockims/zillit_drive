import path from 'path';
import helmet from 'helmet';
import express from 'express';
import bodyParser from 'body-parser';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import fileUpload from 'express-fileupload';

import cors from 'zillit-libs/middlewares-v2/cors';
import httplogger from 'zillit-libs/middlewares-v2/httplogger';
import routeNotFound from 'zillit-libs/middlewares-v2/route-not-found';

import routesV2 from './routes/v2';

const app = express();

app.shutdown = () => {
  // clean up your resources and exit
  process.exit();
};

app.disable('x-powered-by');
app.use(cookieParser());
app.use(helmet());
app.use(cors);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(compression());
app.use(fileUpload());
app.use(httplogger);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'temp')));

// App healthcheck url
app.get('/', (_req, resp) => resp.status(200).json({ message: 'ok' }));

// App routes
app.use('/api/v2/', routesV2);

app.use('*', routeNotFound);

export default app;
