import ApiResponse from 'zillit-libs/utils/api-response';

import DriveTrashService from '../../services/v2/driveTrash.js';

class DriveTrash {
  constructor() {
    this.version = 2;
  }

  async listTrash(req, res) {
    const { user, project, query } = req;
    try {
      const result = await DriveTrashService.listTrash({ user, project, query });
      return ApiResponse.handleResponse(res, { message: 'trash_listed', data: result });
    } catch (error) {
      console.log('[trash_list_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async restoreItem(req, res) {
    const { user, project, device, params } = req;
    try {
      const result = await DriveTrashService.restoreItem({ user, project, device, params });
      return ApiResponse.handleResponse(res, { message: 'item_restored', data: result });
    } catch (error) {
      console.log('[trash_restore_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async permanentDelete(req, res) {
    const { user, project, device, params } = req;
    try {
      const result = await DriveTrashService.permanentDelete({ user, project, device, params });
      return ApiResponse.handleResponse(res, { message: 'item_permanently_deleted', data: result });
    } catch (error) {
      console.log('[trash_permanent_delete_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async emptyTrash(req, res) {
    const { user, project } = req;
    try {
      const result = await DriveTrashService.emptyTrash({ user, project });
      return ApiResponse.handleResponse(res, { message: 'trash_emptied', data: result });
    } catch (error) {
      console.log('[trash_empty_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }
}

export default new DriveTrash();
