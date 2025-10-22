import BadRequest from 'zillit-libs/errors/BadRequest';
import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFolderRepository from '../../repositories/v2/driveFolder.js';
import NotificationService from 'zillit-libs/services-v2/notification';
import NotificationRepository from 'zillit-libs/repositories-v2/notification';
import { rights } from 'zillit-libs/services-v2/permissions';
import socketClient from '../../config/socketClient.js';
import FileShareRepository from 'zillit-libs/repositories-v2/file-share';
import S3Service from 'zillit-libs/services-v2/s3-bucket';

const {
  sections, tools, units,
} = NotificationService.NotificationConstants;

const _viewingRightsUsers = async (project) => {
  const usersWithRights = await rights.toolUsersRights({
    projectId: project._id,
    identifier: 'drive_tool',
  });
  return usersWithRights.filter((item) => item.view_access).map((item) => item.user_id.toString());
};

const createFile = async ({ user, project, device, body, query }) => {
  // Trim and normalize the file name for duplicate checking
  const normalizedFileName = body.file_name.trim().toLowerCase();

  // If folder_id is provided, verify folder exists
  if (body.folder_id) {
    const folder = await DriveFolderRepository.getFolder({
      filters: { _id: body.folder_id, project_id: project._id, deleted_on: 0 }
    });

    if (!folder) {
      throw new BadRequest('folder_not_found');
    }
  }

  // Check if a file with the same name already exists in the same folder
  const filters = {
    project_id: project._id,
    folder_id: body.folder_id || null,
    deleted_on: 0,
  };

  const existingFiles = await DriveFileRepository.getFiles({ filters });

  // Check for duplicate file name (case-insensitive) in the same folder
  const duplicateFile = existingFiles.find(file =>
    file.file_name.trim().toLowerCase() === normalizedFileName
  );

  // if (duplicateFile) {
  //   throw new BadRequest('duplicate_file_name');
  // }

  // Extract file extension from file name
  const fileExtension = body.file_name.split('.').pop().toLowerCase();

  const data = {
    ...body,
    project_id: project._id,
    created_by: user._id,
    updated_by: user._id,
    uploaded_by: user._id,
    file_extension: fileExtension,
  };

  const file = await DriveFileRepository.createFile({ data });

  // Get users with view access to the drive tool
  const usersIds = await _viewingRightsUsers(project);

  // Send notification to users with view access
  await NotificationService.notifyAll({
    data: file,
    sectionId: sections.PROJECT,
    toolId: tools.DRIVE,
    unitId: units.FILE,
    message: `New file "${file.file_name}" uploaded in ${project.name}`,
    receiverIds: usersIds,
    senderId: file.created_by,
    projectId: project._id,
    organizationId: project.organization,
  });

  // Emit socket event for real-time updates
  socketClient('__admin_events__', {
    event: 'file:added',
    room: `${project._id.toString()}_room`,
    data: {
      project_id: project._id,
      device_id: device._id,
      file: file,
    },
  });

  return file;
};

const getFiles = async ({ user, project, query }) => {
  const filters = {
    project_id: project._id,
    deleted_on: 0,
  };

  // If folder_id is provided in query, filter by it
  if (query.folder_id) {
    filters.folder_id = query.folder_id;
  } else if (query.folder_id === null || query.root === 'true') {
    // Get root level files (no folder)
    filters.folder_id = null;
  }

  // Filter by file type if provided
  if (query.file_type) {
    filters.file_type = query.file_type;
  }

  // Filter by file extension if provided
  if (query.file_extension) {
    filters.file_extension = query.file_extension;
  }

  const sort = { created_on: -1 };
  const files = await DriveFileRepository.getFiles({ filters, sort });
  return files;
};

const getFile = async ({ project, params }) => {
  const filters = {
    _id: params.fileId,
    project_id: project._id,
    deleted_on: 0,
  };

  const file = await DriveFileRepository.getFile({ filters });

  if (!file) {
    throw new BadRequest('file_not_found');
  }

  return file;
};

const updateFile = async ({ user, project, device, params, body }) => {
  const fileId = params.fileId || body.file_id;

  if (!fileId) {
    throw new BadRequest('file_id_required');
  }

  const filters = {
    _id: fileId,
    project_id: project._id,
    deleted_on: 0,
  };

  // First check if file exists
  const existingFile = await DriveFileRepository.getFile({ filters });
  if (!existingFile) {
    throw new BadRequest('file_not_found');
  }

  // If updating folder_id, verify new folder exists
  if (body.folder_id && body.folder_id !== existingFile.folder_id?.toString()) {
    const folder = await DriveFolderRepository.getFolder({
      filters: { _id: body.folder_id, project_id: project._id, deleted_on: 0 }
    });

    if (!folder) {
      throw new BadRequest('folder_not_found');
    }
  }

  // If updating file name, check for duplicates in the target folder
  if (body.file_name && body.file_name.trim().toLowerCase() !== existingFile.file_name.trim().toLowerCase()) {
    const normalizedFileName = body.file_name.trim().toLowerCase();
    const targetFolderId = body.folder_id || existingFile.folder_id;

    const duplicateFilters = {
      project_id: project._id,
      folder_id: targetFolderId,
      deleted_on: 0,
      _id: { $ne: fileId } // Exclude current file from duplicate check
    };

    const existingFiles = await DriveFileRepository.getFiles({ filters: duplicateFilters });

    const duplicateFile = existingFiles.find(file =>
      file.file_name.trim().toLowerCase() === normalizedFileName
    );

    if (duplicateFile) {
      throw new BadRequest('duplicate_file_name');
    }
  }

  // Remove file_id from body if it exists (shouldn't be in update data)
  const { file_id, ...bodyWithoutFileId } = body;

  // Update file extension if file name is changed
  let updateData = {
    ...bodyWithoutFileId,
    updated_by: user._id,
    updated_on: Date.now(),
  };

  if (body.file_name) {
    const fileExtension = body.file_name.split('.').pop().toLowerCase();
    updateData.file_extension = fileExtension;
  }

  const updatedFile = await DriveFileRepository.updateFileDocument({ filters, data: updateData });

  if (!updatedFile) {
    throw new BadRequest('file_update_failed');
  }

  // Get users with view access to the drive tool
  const usersIds = await _viewingRightsUsers(project);

  // Send notification to users with view access
  await NotificationService.notifyAll({
    data: updatedFile,
    sectionId: sections.PROJECT,
    toolId: tools.DRIVE,
    unitId: units.FILE,
    message: `File "${updatedFile.file_name}" updated in ${project.name}`,
    receiverIds: usersIds,
    senderId: updatedFile.updated_by,
    projectId: project._id,
    organizationId: project.organization,
  });

  // Emit socket event for real-time updates
  socketClient('__admin_events__', {
    event: 'file:updated',
    room: `${project._id.toString()}_room`,
    data: {
      project_id: project._id,
      device_id: device._id,
      file: updatedFile,
    },
  });

  return updatedFile;
};

const deleteFile = async ({ user, project, device, params }) => {
  const filters = {
    _id: params.fileId,
    project_id: project._id,
    deleted_on: 0,
  };

  const file = await DriveFileRepository.getFile({ filters });

  if (!file) {
    throw new BadRequest('file_not_found');
  }

  // Soft delete the file
  const deleteData = {
    deleted_on: Date.now(),
    updated_by: user._id,
    updated_on: Date.now(),
  };

  // Get file data before deletion for notification
  const fileToDelete = await DriveFileRepository.getFile({ filters });

  await DriveFileRepository.deleteFile({ filters, data: deleteData });

  // Get users with view access to the drive tool
  const usersIds = await _viewingRightsUsers(project);

  // Send notification to users with view access
  await NotificationService.notifyAll({
    data: fileToDelete,
    sectionId: sections.PROJECT,
    toolId: tools.DRIVE,
    unitId: units.FILE,
    message: `File "${fileToDelete.file_name}" deleted from ${project.name}`,
    receiverIds: usersIds,
    senderId: user._id,
    projectId: project._id,
    organizationId: project.organization,
  });

  // Emit socket event for real-time updates
  socketClient('__admin_events__', {
    event: 'file:deleted',
    room: `${project._id.toString()}_room`,
    data: {
      project_id: project._id,
      device_id: device._id,
      file: fileToDelete,
    },
  });

  return { message: 'File deleted successfully' };
};

const moveFile = async ({ user, project, device, params, body }) => {
  const { fileId } = params;
  const { target_folder_id } = body;

  const filters = {
    _id: fileId,
    project_id: project._id,
    deleted_on: 0,
  };

  // Check if file exists
  const file = await DriveFileRepository.getFile({ filters });
  if (!file) {
    throw new BadRequest('file_not_found');
  }

  // If target_folder_id is provided, verify folder exists
  if (target_folder_id) {
    const targetFolder = await DriveFolderRepository.getFolder({
      filters: { _id: target_folder_id, project_id: project._id, deleted_on: 0 }
    });

    if (!targetFolder) {
      throw new BadRequest('target_folder_not_found');
    }
  }

  // Check for duplicate file name in target folder
  const duplicateFilters = {
    project_id: project._id,
    folder_id: target_folder_id || null,
    deleted_on: 0,
    _id: { $ne: fileId }
  };

  const existingFiles = await DriveFileRepository.getFiles({ filters: duplicateFilters });
  const duplicateFile = existingFiles.find(existingFile =>
    existingFile.file_name.trim().toLowerCase() === file.file_name.trim().toLowerCase()
  );

  if (duplicateFile) {
    throw new BadRequest('duplicate_file_name_in_target_folder');
  }

  // Move file to new folder
  const updateData = {
    folder_id: target_folder_id || null,
    updated_by: user._id,
    updated_on: Date.now(),
  };

  const movedFile = await DriveFileRepository.updateFileDocument({ filters, data: updateData });

  // Get users with view access to the drive tool
  const usersIds = await _viewingRightsUsers(project);

  // Send notification to users with view access
  await NotificationService.notifyAll({
    data: movedFile,
    sectionId: sections.PROJECT,
    toolId: tools.DRIVE,
    unitId: units.FILE,
    message: `File "${movedFile.file_name}" moved in ${project.name}`,
    receiverIds: usersIds,
    senderId: movedFile.updated_by,
    projectId: project._id,
    organizationId: project.organization,
  });

  // Emit socket event for real-time updates
  socketClient('__admin_events__', {
    event: 'file:moved',
    room: `${project._id.toString()}_room`,
    data: {
      project_id: project._id,
      device_id: device._id,
      file: movedFile,
    },
  });

  return movedFile;
};

const getFilesByType = async ({ project, query }) => {
  const { file_type } = query;

  if (!file_type) {
    throw new BadRequest('file_type_required');
  }

  const filters = {
    project_id: project._id,
    file_type: file_type,
    deleted_on: 0,
  };

  const sort = { created_on: -1 };
  const files = await DriveFileRepository.getFiles({ filters, sort });
  return files;
};

const shareFile = async ({ user, project, params, body }) => {
  const { fileId } = params;
  const { permissions = 'read', expires_at } = body;

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
  const crypto = await import('crypto');
  const shareToken = crypto.randomBytes(32).toString('hex');

  // Prepare share data (expires_at should be epoch timestamp)
  const shareData = {
    file_id: fileId,
    project_id: project._id,
    share_token: shareToken,
    permissions: permissions, // 'read', 'write', 'download'
    expires_at: expires_at || null, // epoch timestamp or null
    created_by: user._id,
    is_active: true,
  };

  // Save share data using FileShareRepository
  console.log('🔄 About to create share with data:', shareData);
  try {
    const createdShare = await FileShareRepository.createShare(shareData);
    console.log('✅ Created share:', createdShare);
  } catch (error) {
    console.log('❌ Failed to create share:', error);
    throw error;
  }

  return {
    share_token: shareToken,
    share_url: `${process.env.BASE_URL || 'http://localhost:8105'}/api/v2/drive/public/${shareToken}`,
    permissions: permissions,
    expires_at: expires_at,
    created_at: new Date().toISOString(),
  };
};

const getFileShares = async ({ user, project, params }) => {
  const { fileId } = params;

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

  // Get active shares for the file from FileShareRepository
  const activeShares = await FileShareRepository.findByFileId(fileId);

  return activeShares.map(share => ({
    share_token: share.share_token,
    share_url: `${process.env.BASE_URL || 'http://localhost:8105'}/api/v2/drive/public/${share.share_token}`,
    permissions: share.permissions,
    expires_at: share.expires_at,
    created_at: share.created_on,
  }));
};

const revokeFileShare = async ({ user, project, params }) => {
  const { fileId } = params;

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

  // Deactivate all shares for this file using FileShareRepository
  await FileShareRepository.revokeByFileId(fileId);

  return { message: 'All shares revoked successfully' };
};

const getPublicFile = async ({ params }) => {
  const { token } = params;

  console.log('🔍 Looking for token:', token);

  // Find share by token using FileShareRepository
  let share;
  try {
    share = await FileShareRepository.findByToken(token);
    console.log('🎯 Found share:', share);
    
    if (!share) {
      console.log('❌ Share not found - checking all shares...');
      // Debug: List all shares to see what's in the database
      const allShares = await FileShareRepository.findDocuments({ filters: {} });
      console.log('📋 All shares in database:', allShares);
      throw new BadRequest('share_not_found_or_expired');
    }
  } catch (error) {
    console.log('❌ Error finding share:', error);
    throw error;
  }

  // Get file details
  const filters = {
    _id: share.file_id,
    project_id: share.project_id,
    deleted_on: 0,
  };

  const file = await DriveFileRepository.getFile({ filters });
  if (!file) {
    throw new BadRequest('file_not_found');
  }

  // Generate signed URL for private file access
  let signed_url = null;
  let download_url = null;
  let file_access_method = 'metadata_only'; // Track how file can be accessed

  try {
    // Extract S3 information from file attachments
    if (file.attachments && file.attachments.length > 0) {
      const attachment = file.attachments[0]; // Use the first attachment
      
      // Check if we have real S3 data (not placeholder/sample data)
      const hasValidS3Data = attachment.bucket && 
                            attachment.region && 
                            attachment.media && 
                            !attachment.media.includes('/bucket/') && // Exclude placeholder URLs
                            attachment.bucket !== 'sample-bucket' &&
                            attachment.bucket !== 'test-bucket';

      if (hasValidS3Data) {
        const s3Service = new S3Service();
        
        // Extract S3 key from media URL or use the media field directly
        let s3Key = attachment.media;
        
        // If media is a full S3 URL, extract the key
        if (s3Key && s3Key.startsWith('https://s3.amazonaws.com/')) {
          // Extract key from URL like: https://s3.amazonaws.com/bucket/key
          const urlParts = s3Key.split('/');
          s3Key = urlParts.slice(4).join('/'); // Everything after bucket name
        } else if (s3Key && s3Key.startsWith('https://')) {
          // Handle other S3 URL formats
          const url = new URL(s3Key);
          s3Key = url.pathname.substring(1); // Remove leading slash
        }

        if (s3Key && s3Key !== 'file.pdf') { // Exclude placeholder keys
          // First check if the file actually exists in S3
          const s3FileExists = await s3Service.fileExists({
            media: s3Key,
            bucket: attachment.bucket,
            region: attachment.region,
          });

          if (s3FileExists) {
            // Generate signed URL (expires in 1 hour by default)
            const expirationTime = share.expires_at && share.expires_at > 0 ? 
              Math.min(3600, Math.floor((share.expires_at - Date.now()) / 1000)) : 
              3600;
            
            if (expirationTime > 0) {
              signed_url = await s3Service.getSignedUrl({
                media: s3Key,
                bucket: attachment.bucket,
                region: attachment.region,
                expiresIn: expirationTime,
              });

              // For download permission, create a download URL
              if (share.permissions === 'download') {
                download_url = signed_url;
              }

              file_access_method = 's3_signed_url';
            }
          } else {
            console.log(`⚠️  S3 file does not exist: ${attachment.bucket}/${s3Key}`);
            file_access_method = 'file_not_found_in_s3';
          }
        } else {
          console.log('⚠️  Invalid S3 key detected (placeholder data)');
          file_access_method = 'placeholder_data';
        }
      } else {
        console.log('⚠️  No valid S3 data found in attachment');
        file_access_method = 'no_s3_data';
      }
      
      // If no S3 access but we have a direct URL, use that
      if (!signed_url && attachment.media && attachment.media.startsWith('http')) {
        file_access_method = 'direct_url';
        // For demo purposes, provide the direct URL (in production, you might want to proxy this)
        signed_url = attachment.media;
        if (share.permissions === 'download') {
          download_url = attachment.media;
        }
      }
    }
  } catch (error) {
    console.error('Error generating signed URL:', error);
    file_access_method = 'error_generating_signed_url';
  }

  // Generate content streaming URL (always available)
  const baseUrl = process.env.BASE_URL || 'http://localhost:8105';
  const content_stream_url = `${baseUrl}/api/v2/drive/public/${token}/content`;

  // Return file data (excluding sensitive information)
  return {
    _id: file._id,
    file_name: file.file_name,
    file_type: file.file_type,
    file_extension: file.file_extension,
    file_size: file.file_size,
    file_url: file.file_url,
    permissions: share.permissions,
    shared_at: share.created_on,
    expires_at: share.expires_at,
    signed_url: signed_url, // Direct S3 access URL (if available)
    download_url: download_url, // Direct S3 download URL (if available)
    content_stream_url: content_stream_url, // Server-proxied file content (always works)
    file_access_method: file_access_method, // How the file can be accessed
    access_info: {
      has_s3_access: signed_url !== null && !signed_url.includes('/bucket/'),
      has_direct_url: file.attachments?.[0]?.media?.startsWith('http') || false,
      has_content_stream: true, // Always available through our server
      attachment_count: file.attachments?.length || 0,
    }
  };
};

export default {
  createFile,
  getFiles,
  getFile,
  updateFile,
  deleteFile,
  moveFile,
  getFilesByType,
  shareFile,
  getFileShares,
  revokeFileShare,
  getPublicFile,
};
