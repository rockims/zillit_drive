import formatter from 'zillit-libs/utils/formatter';
import { httpStatusCodes } from 'zillit-libs/config';
import ApiResponse from 'zillit-libs/utils/api-response';

import DriveFolderService from '../../services/v2/driveFolder.js';

class DriveFolder {
  constructor() {
    this.version = 2;
  }

  async createFolder(req, res) {
    const {
      user, project, device, body, query,
    } = req;
    try {
      const folder = await DriveFolderService.createFolder({
        user, project, device, body, query,
      });
      return ApiResponse.handleResponse(res, { message: 'folder_created', data: folder });
    } catch (error) {
      console.log('[folder_creation_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async getFolders(req, res) {
    const {
      user, project, query
    } = req;
    try {
      const folders = await DriveFolderService.getFolders({ user, project, query });
      return ApiResponse.handleResponse(res, { message: 'folders_fetched', data: folders });
    } catch (error) {
      console.log('[folders_fetch_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async getFolder(req, res) {
    const {
      user, project, params
    } = req;
    try {
      const folder = await DriveFolderService.getFolder({ user, project, params });
      return ApiResponse.handleResponse(res, { message: 'folder_fetched', data: folder });
    } catch (error) {
      console.log('[folder_fetch_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async updateFolder(req, res) {
    const {
      user, project, device, params, body,
    } = req;
    try {
      const folder = await DriveFolderService.updateFolder({
        user, project, device, params, body,
      });
      return ApiResponse.handleResponse(res, { message: 'folder_updated', data: folder });
    } catch (error) {
      console.log('[folder_update_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async deleteFolder(req, res) {
    const {
      user, project, device, params, query,
    } = req;
    try {
      const result = await DriveFolderService.deleteFolder({
        user, project, device, params, query,
      });
      return ApiResponse.handleResponse(res, { message: 'folder_deleted', data: result });
    } catch (error) {
      console.log('[folder_delete_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async getFolderContents(req, res) {
    const {
      project, params, query
    } = req;
    try {
      const contents = await DriveFolderService.getFolderContents({ project, params, query });
      return ApiResponse.handleResponse(res, { message: 'folder_contents_fetched', data: contents });
    } catch (error) {
      console.log('[folder_contents_fetch_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }
}

export default new DriveFolder();
