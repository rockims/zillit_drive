/**
 * Cross-service URL resolver — mirrors the same pattern used in
 * zillit_script_distribution and zillit_project_managment so any inter-service
 * call from drive resolves the right base URL per environment.
 *
 * Currently used only by driveShareLink.js to reach the email service's
 * /v2/imap-send endpoint (the "distribution email" pipeline).
 */

import dotenv from 'dotenv';

dotenv.config();

const urlConst = {
  dev: {
    CNC_BASE_URL: 'https://emailapi-dev.zillit.com/api',
  },
  qa: {
    CNC_BASE_URL: 'https://emailapi-qa.zillit.com/api',
  },
  prod: {
    CNC_BASE_URL: 'https://emailapi.zillit.com/api',
  },
  preprod: {
    CNC_BASE_URL: 'https://emailapi-preprod.zillit.com/api',
  },
};

const getUrls = (type) => {
  const env = (process.env.NODE_ENV || 'dev').toLowerCase();
  const bucket = urlConst[env] || urlConst.dev;
  return bucket[type];
};

export { getUrls };
