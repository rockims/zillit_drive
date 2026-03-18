import ApiResponse from 'zillit-libs/utils/api-response';

import DriveCommentService from '../../services/v2/driveComment.js';

class DriveComment {
  constructor() {
    this.version = 2;
  }

  async getComments(req, res) {
    const { project, query } = req;
    try {
      const result = await DriveCommentService.getComments({ project, query });
      return ApiResponse.handleResponse(res, { message: 'comments_fetched', data: result });
    } catch (error) {
      console.log('[comments_fetch_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async addComment(req, res) {
    const { user, project, body } = req;
    try {
      const result = await DriveCommentService.addComment({ user, project, body });
      return ApiResponse.handleResponse(res, { message: 'comment_added', data: result });
    } catch (error) {
      console.log('[comment_add_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async updateComment(req, res) {
    const { user, project, params, body } = req;
    try {
      const result = await DriveCommentService.updateComment({ user, project, params, body });
      return ApiResponse.handleResponse(res, { message: 'comment_updated', data: result });
    } catch (error) {
      console.log('[comment_update_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async deleteComment(req, res) {
    const { user, project, params } = req;
    try {
      const result = await DriveCommentService.deleteComment({ user, project, params });
      return ApiResponse.handleResponse(res, { message: 'comment_deleted', data: result });
    } catch (error) {
      console.log('[comment_delete_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }
}

export default new DriveComment();
