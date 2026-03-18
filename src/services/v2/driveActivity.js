import DriveActivity from 'zillit-libs/mongo-models-v2/DriveActivity';

/**
 * DriveActivityService — log and query activity events for drive items.
 */

const log = async ({ projectId, userId, action, itemId, itemType, itemName, details = null }) => {
  try {
    await DriveActivity.create({
      project_id: projectId,
      user_id: userId,
      action,
      item_id: itemId || null,
      item_type: itemType || null,
      item_name: itemName || null,
      details,
    });
  } catch (err) {
    // Activity logging is non-critical — don't let it break operations
    console.error('[drive_activity_log_failed]:', err.message);
  }
};

const getActivity = async ({ project, query }) => {
  const limit = Math.min(parseInt(query?.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(query?.offset, 10) || 0, 0);

  const filters = { project_id: project._id };

  if (query?.item_id) {
    filters.item_id = query.item_id;
  }

  if (query?.user_id) {
    filters.user_id = query.user_id;
  }

  if (query?.action) {
    filters.action = query.action;
  }

  const [items, total] = await Promise.all([
    DriveActivity.find(filters)
      .sort({ created_on: -1 })
      .skip(offset)
      .limit(limit),
    DriveActivity.countDocuments(filters),
  ]);

  return { items, total, limit, offset };
};

export default {
  log,
  getActivity,
};
