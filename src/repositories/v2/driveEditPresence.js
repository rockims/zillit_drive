import DriveEditPresence from 'zillit-libs/mongo-models-v2/DriveEditPresence';

const upsertPresence = ({
  fileId, userId, set, setOnInsert = {},
}) => DriveEditPresence.updateOne(
  { file_id: fileId, user_id: userId },
  { $set: set, $setOnInsert: setOnInsert },
  { upsert: true },
);

const getPresence = ({ filters }) => DriveEditPresence.find(filters).lean();

export default {
  upsertPresence,
  getPresence,
};
