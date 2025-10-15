import DriveFile from 'zillit-libs/mongo-models-v2/DriveFile';

const createFile = ({ data }) => DriveFile.create(data);

const getFile = ({ filters }) => DriveFile.findOne(filters);

const getFiles = ({ filters, sort = { created_on: -1 } }) => DriveFile.find(filters).sort(sort);

const updateFile = ({ filters, data }) => DriveFile.updateOne({ ...filters }, { $set: { ...data } });

const updateFileDocument = ({ filters, data }) =>
  DriveFile.findOneAndUpdate({ ...filters }, { $set: { ...data } }, { new: true });

const updateFiles = ({ filters, data }) => DriveFile.updateMany({ ...filters }, { $set: { ...data } });

const deleteFile = ({ filters, data }) => DriveFile.updateOne({ ...filters }, { $set: { ...data } });

const getFilesByFolder = ({ filters, sort = { created_on: -1 } }) => DriveFile.find(filters).sort(sort);

export default {
  createFile,
  getFile,
  getFiles,
  updateFile,
  updateFileDocument,
  updateFiles,
  deleteFile,
  getFilesByFolder,
};
