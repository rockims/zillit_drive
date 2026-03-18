import DriveFileAccess from 'zillit-libs/mongo-models-v2/DriveFileAccess';

const getAccess = ({ filters }) => DriveFileAccess.findOne(filters);

const getAccesses = ({ filters, sort = { created_on: -1 } }) =>
  DriveFileAccess.find(filters).sort(sort).populate('user_id', 'full_name first_name last_name email profile_image designation_name');

const upsertAccess = ({ filters, data }) =>
  DriveFileAccess.findOneAndUpdate(
    { ...filters },
    { $set: { ...data } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

const updateAccess = ({ filters, data }) =>
  DriveFileAccess.updateOne({ ...filters }, { $set: { ...data } });

const updateAccesses = ({ filters, data }) =>
  DriveFileAccess.updateMany({ ...filters }, { $set: { ...data } });

const countAccesses = ({ filters }) => DriveFileAccess.countDocuments(filters);

const deleteAccess = ({ filters, data }) =>
  DriveFileAccess.updateOne({ ...filters }, { $set: { ...data } });

const distinctFileIds = ({ filters }) => DriveFileAccess.distinct('file_id', filters);

export default {
  getAccess,
  getAccesses,
  upsertAccess,
  updateAccess,
  updateAccesses,
  countAccesses,
  deleteAccess,
  distinctFileIds,
};
