import ApiResponse from 'zillit-libs/utils/api-response';

import DriveActivityService from '../../services/v2/driveActivity.js';

class DriveActivityController {
  constructor() {
    this.version = 2;
  }

  async getActivity(req, res) {
    const { project, query } = req;
    try {
      const result = await DriveActivityService.getActivity({ project, query });
      return ApiResponse.handleResponse(res, { message: 'activity_fetched', data: result });
    } catch (error) {
      console.log('[activity_fetch_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }
}

export default new DriveActivityController();
