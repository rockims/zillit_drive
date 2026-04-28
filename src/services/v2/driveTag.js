import DriveTag from 'zillit-libs/mongo-models-v2/DriveTag';
import DriveItemTag from 'zillit-libs/mongo-models-v2/DriveItemTag';
import BadRequest from 'zillit-libs/errors/BadRequest';

import socketClient from '../../config/socketClient.js';

/**
 * DriveTagService — CRUD for tags and tag assignments.
 */

// ── Tag CRUD ──

const createTag = async ({ user, project, body }) => {
  const name = (body.name || '').trim();
  if (!name) throw new BadRequest('tag_name_required');

  const color = body.color || '#1890ff';

  // Check for duplicates
  const existing = await DriveTag.findOne({
    project_id: project._id,
    name: { $regex: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    deleted_on: 0,
  });

  if (existing) throw new BadRequest('duplicate_tag_name');

  const tag = await DriveTag.create({
    project_id: project._id,
    name,
    color,
    created_by: user._id,
  });

  socketClient('__admin_events__', {
    event: 'drive:tag:created',
    room: `${project._id.toString()}_room`,
    data: {
      project_id: project._id,
      tag,
    },
  });

  return tag;
};

const getTags = async ({ project }) => {
  const tags = await DriveTag.find({
    project_id: project._id,
    deleted_on: 0,
  }).sort({ name: 1 });

  return tags;
};

const updateTag = async ({ user, project, params, body }) => {
  const { tagId } = params;

  const tag = await DriveTag.findOne({
    _id: tagId,
    project_id: project._id,
    deleted_on: 0,
  });

  if (!tag) throw new BadRequest('tag_not_found');

  if (body.name) {
    const name = body.name.trim();
    // Check duplicates excluding self
    const existing = await DriveTag.findOne({
      project_id: project._id,
      name: { $regex: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      deleted_on: 0,
      _id: { $ne: tagId },
    });
    if (existing) throw new BadRequest('duplicate_tag_name');
    tag.name = name;
  }

  if (body.color) tag.color = body.color;

  tag.updated_on = Date.now();
  await tag.save();

  socketClient('__admin_events__', {
    event: 'drive:tag:updated',
    room: `${project._id.toString()}_room`,
    data: {
      project_id: project._id,
      tag,
    },
  });

  return tag;
};

const deleteTag = async ({ user, project, params }) => {
  const { tagId } = params;

  const tag = await DriveTag.findOne({
    _id: tagId,
    project_id: project._id,
    deleted_on: 0,
  });

  if (!tag) throw new BadRequest('tag_not_found');

  // Soft delete the tag
  tag.deleted_on = Date.now();
  await tag.save();

  // Remove all assignments for this tag
  await DriveItemTag.deleteMany({
    project_id: project._id,
    tag_id: tagId,
  });

  socketClient('__admin_events__', {
    event: 'drive:tag:deleted',
    room: `${project._id.toString()}_room`,
    data: {
      project_id: project._id,
      tag_id: tagId,
    },
  });

  return { message: 'Tag deleted' };
};

// ── Tag Assignment ──

const assignTag = async ({ user, project, body }) => {
  const { tag_id, item_id, item_type } = body;

  if (!tag_id || !item_id || !item_type) {
    throw new BadRequest('tag_id_item_id_item_type_required');
  }

  if (!['file', 'folder'].includes(item_type)) {
    throw new BadRequest('invalid_item_type');
  }

  // Verify tag exists
  const tag = await DriveTag.findOne({
    _id: tag_id,
    project_id: project._id,
    deleted_on: 0,
  });
  if (!tag) throw new BadRequest('tag_not_found');

  // Upsert to prevent duplicates
  const assignment = await DriveItemTag.findOneAndUpdate(
    { project_id: project._id, tag_id, item_id },
    {
      project_id: project._id,
      tag_id,
      item_id,
      item_type,
      created_by: user._id,
    },
    { upsert: true, new: true },
  );

  socketClient('__admin_events__', {
    event: 'drive:tag:assigned',
    room: `${project._id.toString()}_room`,
    data: {
      project_id: project._id,
      tag_id,
      item_id,
      item_type,
      assignment,
    },
  });

  return assignment;
};

const removeTag = async ({ user, project, body }) => {
  const { tag_id, item_id } = body;

  if (!tag_id || !item_id) {
    throw new BadRequest('tag_id_and_item_id_required');
  }

  await DriveItemTag.deleteOne({
    project_id: project._id,
    tag_id,
    item_id,
  });

  socketClient('__admin_events__', {
    event: 'drive:tag:removed',
    room: `${project._id.toString()}_room`,
    data: {
      project_id: project._id,
      tag_id,
      item_id,
    },
  });

  return { message: 'Tag removed from item' };
};

const getItemTags = async ({ project, query }) => {
  const { item_id } = query;
  if (!item_id) throw new BadRequest('item_id_required');

  const assignments = await DriveItemTag.find({
    project_id: project._id,
    item_id,
  }).sort({ created_on: -1 });

  // Enrich with tag details
  const tagIds = assignments.map((a) => a.tag_id);
  const tags = await DriveTag.find({
    _id: { $in: tagIds },
    deleted_on: 0,
  });

  const tagMap = {};
  tags.forEach((t) => { tagMap[t._id.toString()] = t; });

  return assignments
    .map((a) => {
      const tag = tagMap[a.tag_id.toString()];
      if (!tag) return null;
      return {
        _id: a._id,
        tag_id: tag._id,
        tag_name: tag.name,
        tag_color: tag.color,
        item_id: a.item_id,
        item_type: a.item_type,
      };
    })
    .filter(Boolean);
};

const getItemsByTag = async ({ project, query }) => {
  const { tag_id, item_type } = query;
  if (!tag_id) throw new BadRequest('tag_id_required');

  const filters = {
    project_id: project._id,
    tag_id,
  };

  if (item_type && ['file', 'folder'].includes(item_type)) {
    filters.item_type = item_type;
  }

  const assignments = await DriveItemTag.find(filters).sort({ created_on: -1 });

  return assignments.map((a) => ({
    item_id: a.item_id,
    item_type: a.item_type,
  }));
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
