import express from 'express';
import { rights } from 'zillit-libs/services-v2/permissions';

const router = express.Router();

/**
 * GET /api/v2/drive/project-users
 * Returns project members who have Drive viewing rights.
 * Only users with view_access on 'drive_tool' are returned.
 */
router.get('/', async (req, res, next) => {
  try {
    const { project, user } = req;
    const ProjectUser = (await import('zillit-libs/mongo-models-v2/ProjectUser')).default;

    // Get user IDs that have Drive viewing rights
    const usersWithRights = await rights.toolUsersRights({
      projectId: project._id,
      identifier: 'drive_tool',
    });
    const driveUserIds = usersWithRights
      .filter((item) => item.view_access)
      .map((item) => item.user_id.toString());

    // Fetch user details for those with Drive access
    const users = await ProjectUser.find(
      {
        project_id: project._id,
        is_active: true,
        _id: { $in: driveUserIds },
      },
      {
        _id: 1,
        full_name: 1,
        first_name: 1,
        last_name: 1,
        email: 1,
        profile_image: 1,
        designation_name: 1,
      }
    ).lean();

    // Exclude the current user (can't share with yourself)
    const filtered = users.filter(
      (u) => u._id.toString() !== user._id.toString()
    );

    return res.json({
      status: 1,
      message: 'project_users_fetched',
      messageElements: [],
      data: filtered,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
