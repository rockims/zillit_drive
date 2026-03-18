import ApiResponse from 'zillit-libs/utils/api-response';

import DriveStorageService from '../../services/v2/driveStorage.js';

class DriveStorage {
  constructor() {
    this.version = 2;
  }

  async getStorageUsage(req, res) {
    const { user, project } = req;
    try {
      const result = await DriveStorageService.getStorageUsage({ user, project });
      return ApiResponse.handleResponse(res, { message: 'storage_usage_fetched', data: result });
    } catch (error) {
      console.log('[storage_usage_fetch_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }
}

export default new DriveStorage();
