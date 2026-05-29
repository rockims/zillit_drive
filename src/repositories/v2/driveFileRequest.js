import DriveFileRequest from 'zillit-libs/mongo-models-v2/DriveFileRequest';

const create = ({ data }) => DriveFileRequest.create(data);

const findByToken = ({ token }) => DriveFileRequest.findOne({ token });

const findById = ({ _id }) => DriveFileRequest.findOne({ _id });

const findActiveByFolder = ({ project_id, destination_folder_id }) => DriveFileRequest
  .find({ project_id, destination_folder_id, revoked: false })
  .sort({ created_on: -1 });

const updateById = ({ _id, data }) => DriveFileRequest.findOneAndUpdate(
  { _id },
  { $set: { ...data, updated_on: Date.now() } },
  { new: true },
);

/**
 * Atomically append a new upload session to a request. Each recipient
 * visit starts a session before uploading any files; the session id
 * is returned to the recipient and passed back on every /upload call
 * so we can attribute multiple files to one visitor.
 */
const appendSession = ({ _id, session }) => DriveFileRequest.findOneAndUpdate(
  { _id },
  { $push: { sessions: session }, $set: { updated_on: Date.now() } },
  { new: true },
);

/**
 * Atomic per-session file append + counter bump. Used after each
 * successful S3 upload + DriveFile create so the stats stay
 * consistent even with concurrent uploads from the same recipient.
 */
const recordSessionFileUpload = ({ _id, session_id, file, bytes }) => DriveFileRequest.findOneAndUpdate(
  { _id, 'sessions.session_id': session_id },
  {
    $push: { 'sessions.$.files': file },
    $set: {
      'sessions.$.last_upload_on': Date.now(),
      updated_on: Date.now(),
    },
    $inc: {
      upload_count: 1,
      total_uploaded_bytes: bytes || 0,
    },
  },
  { new: true },
);

export default {
  create,
  findByToken,
  findById,
  findActiveByFolder,
  updateById,
  appendSession,
  recordSessionFileUpload,
};
