import ApiResponse from 'zillit-libs/utils/api-response';
import DriveFileShareService from '../../services/v2/driveFileShare.js';

class DriveFileShare {
  constructor() {
    this.version = 2;
  }

  /**
   * Generate a shareable link for a file
   * POST /api/v2/drive/files/:fileId/share
   */
  async generateShareLink(req, res) {
    const { user, project, device, params, body } = req;

    try {
      const result = await DriveFileShareService.generateShareLink({
        user, project, device, params, body,
      });
      
      return ApiResponse.handleResponse(res, { 
        message: 'share_link_generated', 
        data: result 
      });
    } catch (error) {
      console.log('[share_link_generation_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  }

  /**
   * Get sharing information for a file
   * GET /api/v2/drive/files/:fileId/share
   */
  async getShareInfo(req, res) {
    const { user, project, params } = req;

    try {
      const shareInfo = await DriveFileShareService.getShareInfo({
        user, project, params,
      });
      
      return ApiResponse.handleResponse(res, { 
        message: 'share_info_fetched', 
        data: shareInfo 
      });
    } catch (error) {
      console.log('[share_info_fetch_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  }

  /**
   * Update sharing settings for a file
   * PUT /api/v2/drive/files/:fileId/share
   */
  async updateShareSettings(req, res) {
    const { user, project, device, params, body } = req;

    try {
      const result = await DriveFileShareService.updateShareSettings({
        user, project, device, params, body,
      });
      
      return ApiResponse.handleResponse(res, { 
        message: 'share_settings_updated', 
        data: result 
      });
    } catch (error) {
      console.log('[share_settings_update_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  }

  /**
   * Disable sharing for a file
   * DELETE /api/v2/drive/files/:fileId/share
   */
  async disableSharing(req, res) {
    const { user, project, device, params } = req;

    try {
      const result = await DriveFileShareService.disableSharing({
        user, project, device, params,
      });
      
      return ApiResponse.handleResponse(res, { 
        message: 'sharing_disabled', 
        data: result 
      });
    } catch (error) {
      console.log('[sharing_disable_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  }

  /**
   * Access a shared file (public endpoint)
   * GET /api/v2/public/files/:shareToken
   */
  async accessSharedFile(req, res) {
    const { shareToken } = req.params;
    const { password } = req.query;

    try {
      const fileData = await DriveFileShareService.accessSharedFile({
        shareToken, password, req,
      });
      
      return ApiResponse.handleResponse(res, { 
        message: 'shared_file_accessed', 
        data: fileData 
      });
    } catch (error) {
      console.log('[shared_file_access_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  }
}

export default new DriveFileShare();
