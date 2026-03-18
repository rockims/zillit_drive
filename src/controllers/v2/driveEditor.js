import ApiResponse from 'zillit-libs/utils/api-response';
import DriveEditorService from '../../services/v2/driveEditor.js';

class DriveEditor {
  constructor() {
    this.version = 2;
  }

  /**
   * GET /:fileId/config
   * Returns the OnlyOffice editor configuration for a file.
   * Browser-facing — full middleware chain (moduleData, checkAccess, etc.)
   */
  async getEditorConfig(req, res) {
    const { user, project, params } = req;
    try {
      const config = await DriveEditorService.getEditorConfig({
        user,
        project,
        params,
        query: req.query,
      });
      return ApiResponse.handleResponse(res, {
        message: 'editor_config_generated',
        data: config,
      });
    } catch (error) {
      console.log('[editor_config_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  }

  /**
   * GET /:fileId/download
   * OnlyOffice server-facing — NO standard middleware.
   * Streams the file from S3 to OnlyOffice Document Server.
   * Auth is via HMAC token in query string.
   */
  async proxyDocumentDownload(req, res) {
    const { params, query } = req;
    try {
      const result = await DriveEditorService.proxyDocumentDownload({
        params,
        query,
        res,
      });
      // If result is null, the response was already handled (piped from S3)
      if (result !== null) {
        return ApiResponse.handleResponse(res, result);
      }
    } catch (error) {
      console.log('[editor_download_proxy_failed]:', error.message);
      return res.status(400).json({ error: 1, message: error.message });
    }
  }

  /**
   * POST /callback
   * Handles the save callback from OnlyOffice Document Server.
   * Server-facing — NO standard middleware (JWT-authenticated).
   * Must always return { error: 0 } or { error: 1 } (OnlyOffice requirement).
   */
  async handleEditorCallback(req, res) {
    const { body, query } = req;
    try {
      const result = await DriveEditorService.handleEditorCallback({
        body,
        query,
      });
      return res.status(200).json(result);
    } catch (error) {
      console.log('[editor_callback_failed]:', error.message);
      // OnlyOffice expects { error: 0 } for success, { error: 1 } for failure
      return res.status(200).json({ error: 1 });
    }
  }

  /**
   * GET /:fileId/page-token
   * Authenticated — mobile app calls this to get a short-lived token
   * for loading the editor page in a WebView.
   */
  async generateEditorPageToken(req, res) {
    const { user, project, params } = req;
    try {
      const result = await DriveEditorService.generateEditorPageToken({
        user,
        project,
        params,
      });
      return ApiResponse.handleResponse(res, {
        message: 'editor_page_token_generated',
        data: result,
      });
    } catch (error) {
      console.log('[editor_page_token_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  }

  /**
   * GET /:fileId/page
   * Token-authenticated — WebView loads this URL.
   * Returns a full HTML page with the OnlyOffice editor.
   */
  async serveEditorPage(req, res) {
    const { params, query } = req;
    try {
      const html = await DriveEditorService.getEditorPage({
        params,
        query,
      });
      res.setHeader('Content-Type', 'text/html');
      return res.send(html);
    } catch (error) {
      console.log('[editor_page_failed]:', error.message);
      res.setHeader('Content-Type', 'text/html');
      return res.status(400).send(
        `<html><body style="font-family:sans-serif;padding:20px;color:#d32f2f;">
          <p>Error: ${error.message}</p>
        </body></html>`
      );
    }
  }
}

export default new DriveEditor();
