import DriveFile from 'zillit-libs/mongo-models-v2/DriveFile';

const createFile = ({ data }) => DriveFile.create(data);

const getFile = ({ filters }) => DriveFile.findOne(filters);

const getFiles = ({
  filters,
  sort = { updated_on: -1, created_on: -1, _id: 1 },
  limit = null,
  skip = null,
  select = null,
}) => {
  const mongooseQuery = DriveFile.find(filters).sort(sort);

  if (select) {
    mongooseQuery.select(select);
  }

  if (skip !== null && skip !== undefined && skip >= 0) {
    mongooseQuery.skip(skip);
  }

  if (limit !== null && limit !== undefined && limit > 0) {
    mongooseQuery.limit(limit);
  }

  return mongooseQuery;
};

const updateFile = ({ filters, data }) => DriveFile.updateOne({ ...filters }, { $set: { ...data } });

const updateFileDocument = ({ filters, data }) =>
  DriveFile.findOneAndUpdate({ ...filters }, { $set: { ...data } }, { new: true });

const updateFiles = ({ filters, data }) => DriveFile.updateMany({ ...filters }, { $set: { ...data } });

const countFiles = ({ filters }) => DriveFile.countDocuments(filters);

const deleteFile = ({ filters, data }) => DriveFile.updateOne({ ...filters }, { $set: { ...data } });

const getFilesByFolder = ({ filters, sort = { updated_on: -1, created_on: -1, _id: 1 } }) => DriveFile.find(filters).sort(sort);

// Version numbers come from an atomic counter on the file. Files that
// already have versions start the counter at their highest number.
const raiseVersionSeqFloor = ({ fileId, floor }) => DriveFile.updateOne(
  { _id: fileId },
  { $max: { version_seq: floor } },
);

const incrementVersionSeq = async ({ fileId }) => {
  const updated = await DriveFile.findOneAndUpdate(
    { _id: fileId },
    { $inc: { version_seq: 1 } },
    { new: true, projection: { version_seq: 1 } },
  );
  return updated?.version_seq;
};

export default {
  createFile,
  getFile,
  getFiles,
  updateFile,
  updateFileDocument,
  updateFiles,
  countFiles,
  deleteFile,
  getFilesByFolder,
  raiseVersionSeqFloor,
  incrementVersionSeq,
};
