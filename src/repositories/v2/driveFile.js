import DriveFile from 'zillit-libs/mongo-models-v2/DriveFile';

const createFile = ({ data }) => DriveFile.create(data);

const getFile = ({ filters }) => DriveFile.findOne(filters);

const getFiles = ({
  filters,
  sort = { created_on: -1 },
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

const getFilesByFolder = ({ filters, sort = { created_on: -1 } }) => DriveFile.find(filters).sort(sort);

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
};
