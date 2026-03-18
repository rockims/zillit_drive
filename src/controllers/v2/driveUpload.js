import ApiResponse from 'zillit-libs/utils/api-response';
import DriveUploadService from '../../services/v2/driveUpload.js';

class DriveUpload {
  constructor() {
    this.version = 2;
  }

  async initiateUpload(req, res) {
    const {
      user, project, device, body,
    } = req;
    try {
      const result = await DriveUploadService.initiateUpload({
        user, project, device, body,
      });
      return ApiResponse.handleResponse(res, { message: 'upload_initiated', data: result });
    } catch (error) {
      console.log('[upload_initiation_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  }

  async completeUpload(req, res) {
    const {
      user, project, device, params, body,
    } = req;
    try {
      const file = await DriveUploadService.completeUpload({
        user, project, device, params, body,
      });
      return ApiResponse.handleResponse(res, { message: 'upload_completed', data: file });
    } catch (error) {
      console.log('[upload_completion_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  }

  async abortUpload(req, res) {
    const {
      user, project, params,
    } = req;
    try {
      const result = await DriveUploadService.abortUpload({
        user, project, params,
      });
      return ApiResponse.handleResponse(res, { message: 'upload_aborted', data: result });
    } catch (error) {
      console.log('[upload_abort_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  }

  async getUploadParts(req, res) {
    const {
      user, project, params,
    } = req;
    try {
      const result = await DriveUploadService.getUploadParts({
        user, project, params,
      });
      return ApiResponse.handleResponse(res, { message: 'upload_parts_fetched', data: result });
    } catch (error) {
      console.log('[upload_parts_fetch_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  }

  async getActiveSessions(req, res) {
    const {
      user, project,
    } = req;
    try {
      const sessions = await DriveUploadService.getActiveSessions({
        user, project,
      });
      return ApiResponse.handleResponse(res, { message: 'active_sessions_fetched', data: sessions });
    } catch (error) {
      console.log('[active_sessions_fetch_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  }
}

export default new DriveUpload();
