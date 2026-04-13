import ApiResponse from 'zillit-libs/utils/api-response';

import DriveBulkService from '../../services/v2/driveBulk.js';

class DriveBulk {
  constructor() {
    this.version = 2;
  }

  async bulkDelete(req, res) {
    const { user, project, device, body } = req;
    try {
      const result = await DriveBulkService.bulkDelete({ user, project, device, body });
      return ApiResponse.handleResponse(res, { message: 'bulk_delete_completed', data: result });
    } catch (error) {
      console.log('[bulk_delete_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async bulkMove(req, res) {
    const { user, project, device, body } = req;
    try {
      const result = await DriveBulkService.bulkMove({ user, project, device, body });
      return ApiResponse.handleResponse(res, { message: 'bulk_move_completed', data: result });
    } catch (error) {
      console.log('[bulk_move_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async bulkDownloadUrls(req, res) {
    const { user, project, body } = req;
    try {
      const result = await DriveBulkService.bulkDownloadUrls({ user, project, body });
      return ApiResponse.handleResponse(res, { message: 'bulk_download_urls_generated', data: result });
    } catch (error) {
      console.log('[bulk_download_urls_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async bulkDownloadZip(req, res) {
    const { user, project, body } = req;
    try {
      await DriveBulkService.bulkDownloadZip({ user, project, body, res });
    } catch (error) {
      console.log('[bulk_download_zip_failed]:');
      if (!res.headersSent) {
        return ApiResponse.handleError(res, error);
      }
    }
  }
}

export default new DriveBulk();
