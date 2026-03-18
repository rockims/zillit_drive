import DriveFavorite from 'zillit-libs/mongo-models-v2/DriveFavorite';
import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFolderRepository from '../../repositories/v2/driveFolder.js';
import BadRequest from 'zillit-libs/errors/BadRequest';

/**
 * DriveFavoriteService — toggle, list, and check favorite status on drive items.
 */

const toggleFavorite = async ({ user, project, body }) => {
  const { item_id, item_type } = body;

  if (!item_id || !item_type) {
    throw new BadRequest('item_id_and_item_type_required');
  }

  if (!['file', 'folder'].includes(item_type)) {
    throw new BadRequest('invalid_item_type');
  }

  // Verify item exists
  if (item_type === 'file') {
    const file = await DriveFileRepository.getFile({
      filters: { _id: item_id, project_id: project._id, deleted_on: 0 },
    });
    if (!file) throw new BadRequest('file_not_found');
  } else {
    const folder = await DriveFolderRepository.getFolder({
      filters: { _id: item_id, project_id: project._id, deleted_on: 0 },
    });
    if (!folder) throw new BadRequest('folder_not_found');
  }

  // Toggle: if exists → remove, else → add
  const existing = await DriveFavorite.findOne({
    project_id: project._id,
    user_id: user._id,
    item_id,
  });

  if (existing) {
    await DriveFavorite.deleteOne({ _id: existing._id });
    return { favorited: false };
  }

  await DriveFavorite.create({
    project_id: project._id,
    user_id: user._id,
    item_id,
    item_type,
  });

  return { favorited: true };
};

const listFavorites = async ({ user, project, query }) => {
  const limit = Math.min(parseInt(query?.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(query?.offset, 10) || 0, 0);

  const favorites = await DriveFavorite.find({
    project_id: project._id,
    user_id: user._id,
  })
    .sort({ created_on: -1 })
    .skip(offset)
    .limit(limit);

  // Enrich with item details
  const enriched = [];

  for (const fav of favorites) {
    let item = null;
    if (fav.item_type === 'file') {
      item = await DriveFileRepository.getFile({
        filters: { _id: fav.item_id, project_id: project._id, deleted_on: 0 },
      });
      if (item) {
        enriched.push({
          ...item.toObject(),
          item_type: 'file',
          name: item.file_name,
          favorited_on: fav.created_on,
        });
      }
    } else {
      item = await DriveFolderRepository.getFolder({
        filters: { _id: fav.item_id, project_id: project._id, deleted_on: 0 },
      });
      if (item) {
        enriched.push({
          ...item.toObject(),
          item_type: 'folder',
          name: item.folder_name,
          favorited_on: fav.created_on,
        });
      }
    }
  }

  const total = await DriveFavorite.countDocuments({
    project_id: project._id,
    user_id: user._id,
  });

  return { items: enriched, total, limit, offset };
};

const getFavoriteIds = async ({ user, project }) => {
  const favorites = await DriveFavorite.find({
    project_id: project._id,
    user_id: user._id,
  }).select('item_id');

  return favorites.map((f) => f.item_id.toString());
};

export default {
  toggleFavorite,
  listFavorites,
  getFavoriteIds,
};
