import DriveFileVersionChange from 'zillit-libs/mongo-models-v2/DriveFileVersionChange';

const getChanges = ({ filters }) => DriveFileVersionChange.findOne(filters).lean();

// One document per version; a retried comparison replaces the earlier one.
const saveChanges = ({ versionId, data }) => DriveFileVersionChange.updateOne(
  { version_id: versionId },
  { $set: { ...data, version_id: versionId } },
  { upsert: true },
);

export default {
  getChanges,
  saveChanges,
};
