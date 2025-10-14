import DriveFolder from 'zillit-libs/mongo-models-v2/DriveFolder';

const createFolder = ({ data }) => DriveFolder.create(data);

const getFolder = ({ filters }) => DriveFolder.findOne(filters);

const getFolders = ({ filters, sort = { created_on: -1 } }) => DriveFolder.find(filters).sort(sort);

const updateFolder = ({ filters, data }) => DriveFolder.updateOne({ ...filters }, { $set: { ...data } });

const updateFolderDocument = ({ filters, data }) =>
  DriveFolder.findOneAndUpdate({ ...filters }, { $set: { ...data } }, { new: true });

const deleteFolder = ({ filters, data }) => DriveFolder.updateOne({ ...filters }, { $set: { ...data } });

export default {
  createFolder,
  getFolder,
  getFolders,
  updateFolder,
  updateFolderDocument,
  deleteFolder,
};
