import ApiResponse from 'zillit-libs/utils/api-response';

import DriveFavoriteService from '../../services/v2/driveFavorite.js';

class DriveFavorite {
  constructor() {
    this.version = 2;
  }

  async toggleFavorite(req, res) {
    const { user, project, body } = req;
    try {
      const result = await DriveFavoriteService.toggleFavorite({ user, project, body });
      return ApiResponse.handleResponse(res, { message: 'favorite_toggled', data: result });
    } catch (error) {
      console.log('[favorite_toggle_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async listFavorites(req, res) {
    const { user, project, query } = req;
    try {
      const result = await DriveFavoriteService.listFavorites({ user, project, query });
      return ApiResponse.handleResponse(res, { message: 'favorites_listed', data: result });
    } catch (error) {
      console.log('[favorites_list_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async getFavoriteIds(req, res) {
    const { user, project } = req;
    try {
      const result = await DriveFavoriteService.getFavoriteIds({ user, project });
      return ApiResponse.handleResponse(res, { message: 'favorite_ids_fetched', data: result });
    } catch (error) {
      console.log('[favorite_ids_fetch_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }
}

export default new DriveFavorite();
