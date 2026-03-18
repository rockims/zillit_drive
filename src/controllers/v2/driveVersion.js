import DriveVersionService from '../../services/v2/driveVersion.js';

const listVersions = async (req, res, next) => {
  try {
    const versions = await DriveVersionService.listVersions({
      project: req.project,
      params: req.params,
    });
    res.json({ status: true, data: versions });
  } catch (err) {
    next(err);
  }
};

const getVersionDownloadUrl = async (req, res, next) => {
  try {
    const result = await DriveVersionService.getVersionDownloadUrl({
      project: req.project,
      params: req.params,
    });
    res.json({ status: true, data: result });
  } catch (err) {
    next(err);
  }
};

const restoreVersion = async (req, res, next) => {
  try {
    const result = await DriveVersionService.restoreVersion({
      user: req.user,
      project: req.project,
      params: req.params,
    });
    res.json({ status: true, message: 'version_restored', data: result });
  } catch (err) {
    next(err);
  }
};

export default {
  listVersions,
  getVersionDownloadUrl,
  restoreVersion,
};
