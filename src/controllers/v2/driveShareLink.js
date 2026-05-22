import ApiResponse from 'zillit-libs/utils/api-response';
import DriveShareLinkService from '../../services/v2/driveShareLink.js';

const DriveShareLinkController = {
  async createShareLink(req, res) {
    try {
      const data = await DriveShareLinkService.createShareLink({
        user: req.user,
        project: req.project,
        params: req.params,
        body: req.body,
      });
      return ApiResponse.handleResponse(res, { message: 'share_link_created', data });
    } catch (error) {
      console.log('[share_link_create_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  },

  async listShareLinks(req, res) {
    try {
      const data = await DriveShareLinkService.listShareLinks({
        user: req.user,
        project: req.project,
        params: req.params,
      });
      return ApiResponse.handleResponse(res, { message: 'share_links_fetched', data });
    } catch (error) {
      console.log('[share_links_list_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  },

  async revokeShareLink(req, res) {
    try {
      const data = await DriveShareLinkService.revokeShareLink({
        user: req.user,
        project: req.project,
        params: req.params,
      });
      return ApiResponse.handleResponse(res, { message: 'share_link_revoked', data });
    } catch (error) {
      console.log('[share_link_revoke_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  },

  /* ───── Public (token-only) endpoints — no auth ───── */

  async getViewerData(req, res) {
    try {
      const data = await DriveShareLinkService.getViewerData({
        params: req.params,
        query: req.query,
      });
      return ApiResponse.handleResponse(res, { message: 'share_viewer_data', data });
    } catch (error) {
      console.log('[share_viewer_data_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  },

  async getStreamUrl(req, res) {
    try {
      const data = await DriveShareLinkService.getStreamUrl({
        params: req.params,
        query: req.query,
        req,
      });
      return ApiResponse.handleResponse(res, { message: 'share_stream_url', data });
    } catch (error) {
      console.log('[share_stream_url_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  },

  async recordView(req, res) {
    try {
      const data = await DriveShareLinkService.recordView({
        params: req.params,
        query: req.query,
        req,
      });
      return ApiResponse.handleResponse(res, { message: 'share_view_recorded', data });
    } catch (error) {
      console.log('[share_view_record_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  },
};

export default DriveShareLinkController;
