import ApiResponse from 'zillit-libs/utils/api-response';

import DriveFileService from '../../services/v2/driveFile.js';

class DriveFile {
  constructor() {
    this.version = 2;
  }

  async createFile(req, res) {
    const {
      user, project, device, body, query,
    } = req;
    try {
      const file = await DriveFileService.createFile({
        user, project, device, body, query,
      });
      return ApiResponse.handleResponse(res, { message: 'file_created', data: file });
    } catch (error) {
      console.log('[file_creation_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async getFiles(req, res) {
    const {
      user, project, query
    } = req;
    try {
      const files = await DriveFileService.getFiles({ user, project, query });
      return ApiResponse.handleResponse(res, { message: 'files_fetched', data: files });
    } catch (error) {
      console.log('[files_fetch_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async getFile(req, res) {
    const {
      user, project, params
    } = req;
    try {
      const file = await DriveFileService.getFile({ user, project, params });
      return ApiResponse.handleResponse(res, { message: 'file_fetched', data: file });
    } catch (error) {
      console.log('[file_fetch_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async updateFile(req, res) {
    const {
      user, project, device, params, body,
    } = req;
    try {
      const file = await DriveFileService.updateFile({
        user, project, device, params, body,
      });
      return ApiResponse.handleResponse(res, { message: 'file_updated', data: file });
    } catch (error) {
      console.log('[file_update_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async deleteFile(req, res) {
    const {
      user, project, device, params,
    } = req;
    try {
      const result = await DriveFileService.deleteFile({
        user, project, device, params,
      });
      return ApiResponse.handleResponse(res, { message: 'file_deleted', data: result });
    } catch (error) {
      console.log('[file_delete_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async moveFile(req, res) {
    const {
      user, project, device, params, body,
    } = req;
    try {
      const file = await DriveFileService.moveFile({
        user, project, device, params, body,
      });
      return ApiResponse.handleResponse(res, { message: 'file_moved', data: file });
    } catch (error) {
      console.log('[file_move_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async getFilesByType(req, res) {
    const {
      user, project, query
    } = req;
    try {
      const files = await DriveFileService.getFilesByType({ user, project, query });
      return ApiResponse.handleResponse(res, { message: 'files_by_type_fetched', data: files });
    } catch (error) {
      console.log('[files_by_type_fetch_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async getFileStreamUrl(req, res) {
    const {
      user, project, params, query,
    } = req;
    try {
      const streamData = await DriveFileService.getFileStreamUrl({
        user, project, params, query,
      });
      return ApiResponse.handleResponse(res, { message: 'file_stream_url_generated', data: streamData });
    } catch (error) {
      console.log('[file_stream_url_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async getFilePreviewUrl(req, res) {
    const {
      user, project, params, query,
    } = req;
    try {
      const streamData = await DriveFileService.getFilePreviewUrl({
        user, project, params, query,
      });
      return ApiResponse.handleResponse(res, { message: 'file_preview_url_generated', data: streamData });
    } catch (error) {
      console.log('[file_preview_url_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async generateShareLink(req, res) {
    const { user, project, params, body } = req;
    try {
      const result = await DriveFileService.generateShareLink({
        user, project, params, body,
      });
      return ApiResponse.handleResponse(res, { message: 'share_link_generated', data: result });
    } catch (error) {
      console.log('[share_link_generation_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }
}

export default new DriveFile();
