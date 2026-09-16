import DriveFolderAccess from 'zillit-libs/mongo-models-v2/DriveFolderAccess';

const createAccess = ({ data }) => DriveFolderAccess.create(data);

const getAccess = ({ filters }) => DriveFolderAccess.findOne(filters);

const getAccesses = ({ filters, sort = { created_on: -1 } }) => DriveFolderAccess.find(filters).sort(sort);

// `setOnInsert` holds fields stamped once at row creation and never rewritten —
// `created_by` above all, which records who granted this folder access. A field
// may appear in `data` OR `setOnInsert`, never both (MongoDB rejects that).
const upsertAccess = ({ filters, data, setOnInsert }) =>
  DriveFolderAccess.findOneAndUpdate(
    { ...filters },
    {
      $set: { ...data },
      ...(setOnInsert && Object.keys(setOnInsert).length > 0
        ? { $setOnInsert: { ...setOnInsert } }
        : {}),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

const updateAccess = ({ filters, data }) => DriveFolderAccess.updateOne({ ...filters }, { $set: { ...data } });

const updateAccesses = ({ filters, data }) =>
  DriveFolderAccess.updateMany({ ...filters }, { $set: { ...data } });

const countAccesses = ({ filters }) => DriveFolderAccess.countDocuments(filters);

const distinctFolderIds = ({ filters }) => DriveFolderAccess.distinct('folder_id', filters);

export default {
  createAccess,
  getAccess,
  getAccesses,
  upsertAccess,
  updateAccess,
  updateAccesses,
  countAccesses,
  distinctFolderIds,
};
