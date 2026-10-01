import ApiResponse from 'zillit-libs/utils/api-response';

import DriveFolderService from '../../services/v2/driveFolder.js';
import DriveFolderZipService from '../../services/v2/driveFolderZip.js';

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

  async getDriveContents(req, res) {
    const {
      user, project, query
    } = req;
    try {
      const contents = await DriveFolderService.getDriveContents({ user, project, query });
      return ApiResponse.handleResponse(res, { message: 'drive_contents_fetched', data: contents });
    } catch (error) {
      console.log('[drive_contents_fetch_failed]:');
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

  async moveFolder(req, res) {
    const {
      user, project, device, params, body,
    } = req;
    try {
      const folder = await DriveFolderService.moveFolder({
        user, project, device, params, body,
      });
      return ApiResponse.handleResponse(res, { message: 'folder_moved', data: folder });
    } catch (error) {
      console.log('[folder_move_failed]:');
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
      user, project, params
    } = req;
    try {
      const contents = await DriveFolderService.getFolderContents({ user, project, params });
      return ApiResponse.handleResponse(res, { message: 'folder_contents_fetched', data: contents });
    } catch (error) {
      console.log('[folder_contents_fetch_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async getFolderAccess(req, res) {
    const {
      user, project, params,
    } = req;
    try {
      const access = await DriveFolderService.getFolderAccess({
        user,
        project,
        params,
      });
      return ApiResponse.handleResponse(res, { message: 'folder_access_fetched', data: access });
    } catch (error) {
      console.log('[folder_access_fetch_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async updateFolderAccess(req, res) {
    const {
      user, project, params, body,
    } = req;
    try {
      const access = await DriveFolderService.updateFolderAccess({
        user,
        project,
        params,
        body,
      });
      return ApiResponse.handleResponse(res, { message: 'folder_access_updated', data: access });
    } catch (error) {
      console.log('[folder_access_update_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async inheritFolderAccess(req, res) {
    const {
      user, project, params,
    } = req;
    try {
      const result = await DriveFolderService.inheritFolderAccess({
        user,
        project,
        params,
      });
      return ApiResponse.handleResponse(res, { message: 'folder_access_inherited', data: result });
    } catch (error) {
      console.log('[folder_access_inherit_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  async createZipDownloadLink(req, res) {
    const { user, project, params } = req;
    try {
      const link = await DriveFolderZipService.createDownloadLink({ user, project, params });
      return ApiResponse.handleResponse(res, { message: 'folder_zip_link_created', data: link });
    } catch (error) {
      console.log('[folder_zip_link_failed]:');
      return ApiResponse.handleError(res, error);
    }
  }

  // Token-authenticated: the browser opens this URL to save the zip.
  async downloadZip(req, res) {
    const { query } = req;
    try {
      return await DriveFolderZipService.streamZip({ query, res });
    } catch (error) {
      console.log('[folder_zip_failed]:');
      if (res.headersSent) return null;
      return ApiResponse.handleError(res, error);
    }
  }
}

export default new DriveFolder();
