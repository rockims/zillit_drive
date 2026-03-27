import express from 'express';

const router = express.Router();

/**
 * GET /api/v2/drive/project-users
 * Returns list of project members for sharing UI.
 * Uses the ProjectUser model from zillit-libs (same collection the middleware uses).
 */
router.get('/', async (req, res, next) => {
  try {
    const { project, user } = req;
    const ProjectUser = (await import('zillit-libs/mongo-models-v2/ProjectUser')).default;

    const users = await ProjectUser.find(
      {
        project_id: project._id,
        is_active: true,
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

    // Exclude the current user from the list (can't share with yourself)
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
