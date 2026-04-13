import ApiResponse from 'zillit-libs/utils/api-response';
import DriveFileAccessService from '../../services/v2/driveFileAccess.js';

class DriveFileAccess {
  constructor() {
    this.version = 2;
  }

  async getFileAccess(req, res) {
    const { user, project, params } = req;
    try {
      const accessList = await DriveFileAccessService.getFileAccess({
        user,
        project,
        fileId: params.fileId,
      });
      return ApiResponse.handleResponse(res, {
        message: 'file_access_fetched',
        data: accessList,
      });
    } catch (error) {
      console.log('[get_file_access_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  }

  async updateFileAccess(req, res) {
    const { user, project, params, body } = req;
    try {
      const accessList = await DriveFileAccessService.setFileAccessList({
        user,
        project,
        fileId: params.fileId,
        entries: body.entries,
      });
      return ApiResponse.handleResponse(res, {
        message: 'file_access_updated',
        data: accessList,
      });
    } catch (error) {
      console.log('[update_file_access_failed]:', error.message);
      return ApiResponse.handleError(res, error);
    }
  }
}

export default new DriveFileAccess();
