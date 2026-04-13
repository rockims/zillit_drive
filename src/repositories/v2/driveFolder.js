import DriveFolder from 'zillit-libs/mongo-models-v2/DriveFolder';

const createFolder = ({ data }) => DriveFolder.create(data);

const getFolder = ({ filters }) => DriveFolder.findOne(filters);

const getFolders = ({
  filters,
  sort = { created_on: -1 },
  limit = null,
  skip = null,
}) => {
  const mongooseQuery = DriveFolder.find(filters).sort(sort);

  if (skip !== null && skip !== undefined && skip >= 0) {
    mongooseQuery.skip(skip);
  }

  if (limit !== null && limit !== undefined && limit > 0) {
    mongooseQuery.limit(limit);
  }

  return mongooseQuery;
};

const updateFolder = ({ filters, data }) => DriveFolder.updateOne({ ...filters }, { $set: { ...data } });

const updateFolderDocument = ({ filters, data }) =>
  DriveFolder.findOneAndUpdate({ ...filters }, { $set: { ...data } }, { new: true });

const updateFolders = ({ filters, data }) => DriveFolder.updateMany({ ...filters }, { $set: { ...data } });

const countFolders = ({ filters }) => DriveFolder.countDocuments(filters);

const deleteFolder = ({ filters, data }) => DriveFolder.updateOne({ ...filters }, { $set: { ...data } });

export default {
  createFolder,
  getFolder,
  getFolders,
  updateFolder,
  updateFolderDocument,
  updateFolders,
  countFolders,
  deleteFolder,
};
