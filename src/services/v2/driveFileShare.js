import { v4 as uuidv4 } from 'uuid';
import BadRequest from 'zillit-libs/errors/BadRequest';
import DriveFileRepository from '../../repositories/v2/driveFile.js';
import socketClient from '../../config/socketClient.js';

/**
 * Generate a shareable link for a file
 */
const generateShareLink = async ({ user, project, device, params, body = {} }) => {
  const { fileId } = params;
  const { 
    expiresAt = null,
    allowDownload = true,
    password = null,
    accessLevel = 'view' // 'view' or 'download'
  } = body;

  // Check if file exists
  const filters = {
    _id: fileId,
    project_id: project._id,
    deleted_on: 0,
  };

  const file = await DriveFileRepository.getFile({ filters });

  if (!file) {
    throw new BadRequest('file_not_found');
  }

  // Generate unique share token
  const shareToken = uuidv4();
  const shareUrl = `${process.env.BASE_URL || 'http://localhost:8105'}/api/v2/public/files/${shareToken}`;

  // Prepare sharing data
  const shareData = {
    sharing: {
      is_shared: true,
      share_token: shareToken,
      share_url: shareUrl,
      shared_by: user._id,
      shared_on: Date.now(),
      expires_at: expiresAt ? new Date(expiresAt).getTime() : null,
      allow_download: allowDownload,
      password: password || null,
      access_level: accessLevel,
      access_count: 0,
      last_accessed: null
    },
    updated_by: user._id,
    updated_on: Date.now(),
  };

  // Update file with sharing information
  const updatedFile = await DriveFileRepository.updateFileDocument({
    filters,
    data: shareData
  });

  // Emit socket event for real-time updates
  await socketClient.socketToRoom({
    room: project._id.toString(),
    emit: 'file:shared',
    data: { file: updatedFile, project: project._id },
  });

  return {
    ...updatedFile.toObject(),
    share_url: shareUrl,
    share_token: shareToken
  };
};

/**
 * Get sharing information for a file
 */
const getShareInfo = async ({ user, project, params }) => {
  const { fileId } = params;

  const filters = {
    _id: fileId,
    project_id: project._id,
    deleted_on: 0,
  };

  const file = await DriveFileRepository.getFile({ filters });

  if (!file) {
    throw new BadRequest('file_not_found');
  }

  if (!file.sharing || !file.sharing.is_shared) {
    throw new BadRequest('file_not_shared');
  }

  return {
    file_id: file._id,
    file_name: file.file_name,
    sharing: file.sharing,
    share_url: file.sharing.share_url
  };
};

/**
 * Update sharing settings for a file
 */
const updateShareSettings = async ({ user, project, device, params, body }) => {
  const { fileId } = params;
  const { 
    expiresAt,
    allowDownload,
    password,
    accessLevel
  } = body;

  const filters = {
    _id: fileId,
    project_id: project._id,
    deleted_on: 0,
  };

  const file = await DriveFileRepository.getFile({ filters });

  if (!file) {
    throw new BadRequest('file_not_found');
  }

  if (!file.sharing || !file.sharing.is_shared) {
    throw new BadRequest('file_not_shared');
  }

  // Update sharing settings
  const shareData = {
    'sharing.expires_at': expiresAt ? new Date(expiresAt).getTime() : file.sharing.expires_at,
    'sharing.allow_download': allowDownload !== undefined ? allowDownload : file.sharing.allow_download,
    'sharing.password': password !== undefined ? password : file.sharing.password,
    'sharing.access_level': accessLevel || file.sharing.access_level,
    updated_by: user._id,
    updated_on: Date.now(),
  };

  const updatedFile = await DriveFileRepository.updateFileDocument({
    filters,
    data: shareData
  });

  // Emit socket event for real-time updates
  await socketClient.socketToRoom({
    room: project._id.toString(),
    emit: 'file:share_updated',
    data: { file: updatedFile, project: project._id },
  });

  return updatedFile;
};

/**
 * Disable sharing for a file
 */
const disableSharing = async ({ user, project, device, params }) => {
  const { fileId } = params;

  const filters = {
    _id: fileId,
    project_id: project._id,
    deleted_on: 0,
  };

  const file = await DriveFileRepository.getFile({ filters });

  if (!file) {
    throw new BadRequest('file_not_found');
  }

  if (!file.sharing || !file.sharing.is_shared) {
    throw new BadRequest('file_not_shared');
  }

  // Disable sharing
  const shareData = {
    'sharing.is_shared': false,
    'sharing.disabled_on': Date.now(),
    'sharing.disabled_by': user._id,
    updated_by: user._id,
    updated_on: Date.now(),
  };

  const updatedFile = await DriveFileRepository.updateFileDocument({
    filters,
    data: shareData
  });

  // Emit socket event for real-time updates
  await socketClient.socketToRoom({
    room: project._id.toString(),
    emit: 'file:share_disabled',
    data: { file: updatedFile, project: project._id },
  });

  return updatedFile;
};

/**
 * Access a shared file (public endpoint)
 */
const accessSharedFile = async ({ shareToken, password = null, req }) => {
  // Find file by share token
  const filters = {
    'sharing.share_token': shareToken,
    'sharing.is_shared': true,
    deleted_on: 0,
  };

  const file = await DriveFileRepository.getFile({ filters });

  if (!file) {
    throw new BadRequest('shared_file_not_found');
  }

  const sharing = file.sharing;

  // Check if sharing has expired
  if (sharing.expires_at && Date.now() > sharing.expires_at) {
    throw new BadRequest('shared_link_expired');
  }

  // Check password if required
  if (sharing.password && sharing.password !== password) {
    throw new BadRequest('invalid_password');
  }

  // Update access statistics
  const accessData = {
    'sharing.access_count': (sharing.access_count || 0) + 1,
    'sharing.last_accessed': Date.now(),
  };

  await DriveFileRepository.updateFile({
    filters: { _id: file._id },
    data: accessData
  });

  // Return file information based on access level
  const fileData = {
    _id: file._id,
    file_name: file.file_name,
    description: file.description,
    file_type: file.file_type,
    file_extension: file.file_extension,
    file_size: file.file_size,
    file_size_bytes: file.file_size_bytes,
    mime_type: file.mime_type,
    created_on: file.created_on,
    access_level: sharing.access_level,
    allow_download: sharing.allow_download
  };

  // Include attachment/download info if allowed
  if (sharing.access_level === 'download' || sharing.allow_download) {
    fileData.attachment = file.attachment;
    fileData.attachments = file.attachments;
  }

  return fileData;
};

export default {
  generateShareLink,
  getShareInfo,
  updateShareSettings,
  disableSharing,
  accessSharedFile,
};
