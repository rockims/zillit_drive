import ApiResponse from 'zillit-libs/utils/api-response';
import DriveTagService from '../../services/v2/driveTag.js';

const createTag = async (req, res, next) => {
  try {
    const tag = await DriveTagService.createTag({
      user: req.user,
      project: req.project,
      body: req.body,
    });
    return ApiResponse.handleResponse(res, { message: 'tag_created', data: tag });
  } catch (err) {
    return ApiResponse.handleError(res, err);
  }
};

const getTags = async (req, res, next) => {
  try {
    const tags = await DriveTagService.getTags({ project: req.project });
    return ApiResponse.handleResponse(res, { message: 'tags_fetched', data: tags });
  } catch (err) {
    return ApiResponse.handleError(res, err);
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
    return ApiResponse.handleResponse(res, { message: 'tag_updated', data: tag });
  } catch (err) {
    return ApiResponse.handleError(res, err);
  }
};

const deleteTag = async (req, res, next) => {
  try {
    const result = await DriveTagService.deleteTag({
      user: req.user,
      project: req.project,
      params: req.params,
    });
    return ApiResponse.handleResponse(res, { message: 'tag_deleted', data: result });
  } catch (err) {
    return ApiResponse.handleError(res, err);
  }
};

const assignTag = async (req, res, next) => {
  try {
    const result = await DriveTagService.assignTag({
      user: req.user,
      project: req.project,
      body: req.body,
    });
    return ApiResponse.handleResponse(res, { message: 'tag_assigned', data: result });
  } catch (err) {
    return ApiResponse.handleError(res, err);
  }
};

const removeTag = async (req, res, next) => {
  try {
    const result = await DriveTagService.removeTag({
      user: req.user,
      project: req.project,
      body: req.body,
    });
    return ApiResponse.handleResponse(res, { message: 'tag_removed', data: result });
  } catch (err) {
    return ApiResponse.handleError(res, err);
  }
};

const getItemTags = async (req, res, next) => {
  try {
    const tags = await DriveTagService.getItemTags({
      project: req.project,
      query: req.query,
    });
    return ApiResponse.handleResponse(res, { message: 'item_tags_fetched', data: tags });
  } catch (err) {
    return ApiResponse.handleError(res, err);
  }
};

const getItemsByTag = async (req, res, next) => {
  try {
    const items = await DriveTagService.getItemsByTag({
      project: req.project,
      query: req.query,
    });
    return ApiResponse.handleResponse(res, { message: 'items_by_tag_fetched', data: items });
  } catch (err) {
    return ApiResponse.handleError(res, err);
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
