import DriveComment from 'zillit-libs/mongo-models-v2/DriveComment';
import DriveFileRepository from '../../repositories/v2/driveFile.js';
import BadRequest from 'zillit-libs/errors/BadRequest';

/**
 * DriveCommentService — CRUD for file comments with threading support.
 */

const getComments = async ({ project, query }) => {
  const { file_id } = query;

  if (!file_id) {
    throw new BadRequest('file_id_required');
  }

  const limit = Math.min(parseInt(query?.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(query?.offset, 10) || 0, 0);

  const [comments, total] = await Promise.all([
    DriveComment.find({
      project_id: project._id,
      file_id,
      deleted_on: 0,
      parent_comment_id: null, // Top-level comments only
    })
      .sort({ created_on: -1 })
      .skip(offset)
      .limit(limit),
    DriveComment.countDocuments({
      project_id: project._id,
      file_id,
      deleted_on: 0,
      parent_comment_id: null,
    }),
  ]);

  // Fetch replies for each top-level comment
  const enriched = [];
  for (const comment of comments) {
    const replies = await DriveComment.find({
      project_id: project._id,
      parent_comment_id: comment._id,
      deleted_on: 0,
    }).sort({ created_on: 1 });

    enriched.push({
      ...comment.toObject(),
      replies: replies.map((r) => r.toObject()),
    });
  }

  return { comments: enriched, total, limit, offset };
};

const addComment = async ({ user, project, body }) => {
  const { file_id, text, parent_comment_id } = body;

  if (!file_id || !text) {
    throw new BadRequest('file_id_and_text_required');
  }

  if (text.length > 2000) {
    throw new BadRequest('comment_too_long');
  }

  // Verify file exists
  const file = await DriveFileRepository.getFile({
    filters: { _id: file_id, project_id: project._id, deleted_on: 0 },
  });
  if (!file) throw new BadRequest('file_not_found');

  // If replying, verify parent comment exists
  if (parent_comment_id) {
    const parent = await DriveComment.findOne({
      _id: parent_comment_id,
      project_id: project._id,
      deleted_on: 0,
    });
    if (!parent) throw new BadRequest('parent_comment_not_found');
  }

  const comment = await DriveComment.create({
    project_id: project._id,
    file_id,
    user_id: user._id,
    text: text.trim(),
    parent_comment_id: parent_comment_id || null,
  });

  return comment;
};

const updateComment = async ({ user, project, params, body }) => {
  const { commentId } = params;
  const { text } = body;

  if (!text) throw new BadRequest('text_required');

  const comment = await DriveComment.findOne({
    _id: commentId,
    project_id: project._id,
    deleted_on: 0,
  });

  if (!comment) throw new BadRequest('comment_not_found');

  // Only the comment author can edit
  if (comment.user_id.toString() !== user._id.toString()) {
    throw new BadRequest('only_author_can_edit');
  }

  comment.text = text.trim();
  comment.updated_on = Date.now();
  await comment.save();

  return comment;
};

const deleteComment = async ({ user, project, params }) => {
  const { commentId } = params;

  const comment = await DriveComment.findOne({
    _id: commentId,
    project_id: project._id,
    deleted_on: 0,
  });

  if (!comment) throw new BadRequest('comment_not_found');

  // Only the comment author can delete
  if (comment.user_id.toString() !== user._id.toString()) {
    throw new BadRequest('only_author_can_delete');
  }

  const now = Date.now();

  // Soft delete comment and all its replies
  await Promise.all([
    DriveComment.updateOne(
      { _id: commentId },
      { $set: { deleted_on: now, updated_on: now } },
    ),
    DriveComment.updateMany(
      { parent_comment_id: commentId, deleted_on: 0 },
      { $set: { deleted_on: now, updated_on: now } },
    ),
  ]);

  return { message: 'Comment deleted' };
};

export default {
  getComments,
  addComment,
  updateComment,
  deleteComment,
};
