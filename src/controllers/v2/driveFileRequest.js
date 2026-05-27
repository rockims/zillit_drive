import ApiResponse from 'zillit-libs/utils/api-response';
import DriveFileRequestService from '../../services/v2/driveFileRequest.js';

const DriveFileRequestController = {
  /* ──── Authenticated ──── */

  async createFileRequest(req, res) {
    try {
      const data = await DriveFileRequestService.createFileRequest({
        user: req.user,
        project: req.project,
        body: req.body,
      });
      return ApiResponse.handleResponse(res, { message: 'file_request_created', data });
    } catch (error) {
      console.log('[file_request_create_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  },

  async listFileRequests(req, res) {
    try {
      const data = await DriveFileRequestService.listFileRequests({
        user: req.user,
        project: req.project,
        params: req.params,
      });
      return ApiResponse.handleResponse(res, { message: 'file_requests_fetched', data });
    } catch (error) {
      console.log('[file_requests_list_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  },

  async revokeFileRequest(req, res) {
    try {
      const data = await DriveFileRequestService.revokeFileRequest({
        user: req.user,
        project: req.project,
        params: req.params,
      });
      return ApiResponse.handleResponse(res, { message: 'file_request_revoked', data });
    } catch (error) {
      console.log('[file_request_revoke_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  },

  /* ──── Public (token-only) ──── */

  async getRequestViewerData(req, res) {
    try {
      const data = await DriveFileRequestService.getRequestViewerData({
        params: req.params,
      });
      return ApiResponse.handleResponse(res, { message: 'file_request_viewer_data', data });
    } catch (error) {
      console.log('[file_request_viewer_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  },

  async startUploadSession(req, res) {
    try {
      const data = await DriveFileRequestService.startUploadSession({
        params: req.params,
        body: req.body,
        req,
      });
      return ApiResponse.handleResponse(res, { message: 'upload_session_started', data });
    } catch (error) {
      console.log('[upload_session_start_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  },

  async receiveUpload(req, res) {
    try {
      const data = await DriveFileRequestService.receiveUpload({
        params: req.params,
        query: req.query,
        req,
      });
      return ApiResponse.handleResponse(res, { message: 'upload_received', data });
    } catch (error) {
      console.log('[upload_receive_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  },
};

export default DriveFileRequestController;
