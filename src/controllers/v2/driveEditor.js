import ApiResponse from 'zillit-libs/utils/api-response';
import DriveEditorService from '../../services/v2/driveEditor.js';

class DriveEditor {
  constructor() {
    this.version = 2;
  }

  /**
   * GET /:fileId/config
   * Returns the Collabora editor configuration for a file.
   */
  async getEditorConfig(req, res) {
    const { user, project, params } = req;
    try {
      const config = await DriveEditorService.getEditorConfig({
        user, project, params, query: req.query,
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
   * GET /:fileId/page-token
   * Mobile app calls this to get a short-lived JWT for WebView.
   */
  async generateEditorPageToken(req, res) {
    const { user, project, params } = req;
    try {
      const result = await DriveEditorService.generateEditorPageToken({ user, project, params });
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
   * WebView loads this URL — returns HTML with Collabora iframe.
   */
  async serveEditorPage(req, res) {
    const { params, query } = req;
    try {
      const html = await DriveEditorService.getEditorPage({ params, query });
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
