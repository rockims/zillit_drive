import DriveTagService from '../../services/v2/driveTag.js';

const createTag = async (req, res, next) => {
  try {
    const tag = await DriveTagService.createTag({
      user: req.user,
      project: req.project,
      body: req.body,
    });
    res.json({ status: true, message: 'tag_created', data: tag });
  } catch (err) {
    next(err);
  }
};

const getTags = async (req, res, next) => {
  try {
    const tags = await DriveTagService.getTags({ project: req.project });
    res.json({ status: true, data: tags });
  } catch (err) {
    next(err);
  }
};

const updateTag = async (req, res, next) => {
  try {
    const tag = await DriveTagService.updateTag({
      user: req.user,
      project: req.project,
      params: req.params,
      body: req.body,
    });
    res.json({ status: true, message: 'tag_updated', data: tag });
  } catch (err) {
    next(err);
  }
};

const deleteTag = async (req, res, next) => {
  try {
    const result = await DriveTagService.deleteTag({
      user: req.user,
      project: req.project,
      params: req.params,
    });
    res.json({ status: true, ...result });
  } catch (err) {
    next(err);
  }
};

const assignTag = async (req, res, next) => {
  try {
    const result = await DriveTagService.assignTag({
      user: req.user,
      project: req.project,
      body: req.body,
    });
    res.json({ status: true, message: 'tag_assigned', data: result });
  } catch (err) {
    next(err);
  }
};

const removeTag = async (req, res, next) => {
  try {
    const result = await DriveTagService.removeTag({
      user: req.user,
      project: req.project,
      body: req.body,
    });
    res.json({ status: true, ...result });
  } catch (err) {
    next(err);
  }
};

const getItemTags = async (req, res, next) => {
  try {
    const tags = await DriveTagService.getItemTags({
      project: req.project,
      query: req.query,
    });
    res.json({ status: true, data: tags });
  } catch (err) {
    next(err);
  }
};

const getItemsByTag = async (req, res, next) => {
  try {
    const items = await DriveTagService.getItemsByTag({
      project: req.project,
      query: req.query,
    });
    res.json({ status: true, data: items });
  } catch (err) {
    next(err);
  }
};

export default {
  createTag,
  getTags,
  updateTag,
  deleteTag,
  assignTag,
  removeTag,
  getItemTags,
  getItemsByTag,
};
