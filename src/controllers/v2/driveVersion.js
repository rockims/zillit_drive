import ApiResponse from 'zillit-libs/utils/api-response';
import DriveVersionService from '../../services/v2/driveVersion.js';

// Each handler passes the request context to the service and wraps the
// result (or error) in the standard API response.
const handle = (serviceMethod, message) => async (req, res) => {
  try {
    const data = await serviceMethod({
      user: req.user,
      project: req.project,
      params: req.params,
      body: req.body,
    });
    return ApiResponse.handleResponse(res, { message, data });
  } catch (err) {
    return ApiResponse.handleError(res, err);
  }
};

export default {
  listVersions: handle(DriveVersionService.listVersions, 'versions_listed'),
  getHistory: handle(DriveVersionService.getHistory, 'version_history_fetched'),
  getVersionChanges: handle(DriveVersionService.getVersionChanges, 'version_changes_fetched'),
  getVersionPreviewConfig: handle(DriveVersionService.getVersionPreviewConfig, 'version_preview_generated'),
  getVersionDownloadUrl: handle(DriveVersionService.getVersionDownloadUrl, 'version_download_url_generated'),
  renameVersion: handle(DriveVersionService.renameVersion, 'version_renamed'),
  restoreVersion: handle(DriveVersionService.restoreVersion, 'version_restored'),
};
