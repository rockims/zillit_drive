import express from 'express';
import DriveWopiService from '../../services/v2/driveWopi.js';

const router = express.Router();

/**
 * WOPI CheckFileInfo — Collabora calls this to get file metadata + permissions.
 * Auth: access_token query param (JWT).
 * No standard middleware — Collabora authenticates via the token.
 */
router.get('/files/:fileId', async (req, res) => {
  try {
    const result = await DriveWopiService.checkFileInfo({
      params: req.params,
      query: req.query,
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error('[wopi_checkfileinfo_failed]:', error.message);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

/**
 * WOPI GetFile — Collabora calls this to download file contents.
 * Auth: access_token query param (JWT).
 */
router.get('/files/:fileId/contents', async (req, res) => {
  try {
    const result = await DriveWopiService.getFileContents({
      params: req.params,
      query: req.query,
      res,
    });
    // result is null when response is piped from S3
    if (result !== null) {
      return res.status(200).json(result);
    }
  } catch (error) {
    console.error('[wopi_getfile_failed]:', error.message);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

/**
 * WOPI PutFile — Collabora calls this to save edited file contents.
 * Auth: access_token query param (JWT).
 * Body: raw file binary (not JSON).
 */
router.post('/files/:fileId/contents', express.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
  try {
    const result = await DriveWopiService.putFileContents({
      params: req.params,
      query: req.query,
      req,
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error('[wopi_putfile_failed]:', error.message);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

export default router;
