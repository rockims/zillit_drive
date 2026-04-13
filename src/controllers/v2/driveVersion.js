import ApiResponse from 'zillit-libs/utils/api-response';
import DriveVersionService from '../../services/v2/driveVersion.js';

const listVersions = async (req, res, next) => {
  try {
    const versions = await DriveVersionService.listVersions({
      project: req.project,
      params: req.params,
    });
    return ApiResponse.handleResponse(res, { message: 'versions_listed', data: versions });
  } catch (err) {
    return ApiResponse.handleError(res, err);
  }
};

const getVersionDownloadUrl = async (req, res, next) => {
  try {
    const result = await DriveVersionService.getVersionDownloadUrl({
      project: req.project,
      params: req.params,
    });
    return ApiResponse.handleResponse(res, { message: 'version_download_url_generated', data: result });
  } catch (err) {
    return ApiResponse.handleError(res, err);
  }
};

const restoreVersion = async (req, res, next) => {
  try {
    const result = await DriveVersionService.restoreVersion({
      user: req.user,
      project: req.project,
      params: req.params,
    });
    return ApiResponse.handleResponse(res, { message: 'version_restored', data: result });
  } catch (err) {
    return ApiResponse.handleError(res, err);
  }
};

export default {
  listVersions,
  getVersionDownloadUrl,
  restoreVersion,
};
