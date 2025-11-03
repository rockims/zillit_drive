import BadRequest from 'zillit-libs/errors/BadRequest';
import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFolderRepository from '../../repositories/v2/driveFolder.js';
import NotificationService from 'zillit-libs/services-v2/notification';
import NotificationRepository from 'zillit-libs/repositories-v2/notification';
import { rights } from 'zillit-libs/services-v2/permissions';
import socketClient from '../../config/socketClient.js';
import S3BucketService from 'zillit-libs/services-v2/s3-bucket';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

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

  // Handle attachment conversion: singular 'attachment' to plural 'attachments' array
  let attachments = [];
  if (body.attachments && Array.isArray(body.attachments)) {
    // If attachments array is provided, use it
    attachments = body.attachments;
  } else if (body.attachment && typeof body.attachment === 'object') {
    // If single attachment object is provided, convert to array
    attachments = [body.attachment];
  }

  const data = {
    ...body,
    project_id: project._id,
    created_by: user._id,
    updated_by: user._id,
    uploaded_by: user._id,
    file_extension: fileExtension,
    attachments: attachments,
  };

  // Remove the singular 'attachment' field to avoid confusion
  delete data.attachment;

  const file = await DriveFileRepository.createFile({ data });

  // Copy attachments from original S3 bucket to public bucket
  // This follows the same pattern as script-distribution's getScript function
  if (file.attachments && Array.isArray(file.attachments) && file.attachments.length > 0) {
    const s3Service = new S3BucketService();
    const publicBucket = 'zillit-s3-drive-bucket';
    const publicRegion = 'us-east-1';
    const updatedAttachments = [];
    
    console.log('📋 Processing', file.attachments.length, 'attachment(s) for S3 copy...');

    for (const attachment of file.attachments) {
      try {
        // Skip if already in public bucket
        if (attachment.bucket === publicBucket && attachment.region === publicRegion) {
          console.log('ℹ️  File already in target bucket, skipping copy...');
          const publicUrl = `https://${publicBucket}.s3.${publicRegion}.amazonaws.com/${attachment.media}`;
          updatedAttachments.push({
            ...attachment,
            public_url: publicUrl,
          });
          continue;
        }
        
        if (attachment.media && attachment.bucket && attachment.region) {
          console.log('🔄 Starting S3 copy from original bucket...');
          console.log('   Source bucket:', attachment.bucket);
          console.log('   Source region:', attachment.region);
          console.log('   Source key:', attachment.media);
          console.log('   Target bucket:', publicBucket);
          console.log('   Target region:', publicRegion);
          
          // Get file from original S3 bucket (same as getScript does)
          console.log('   📥 Fetching file from source bucket...');
          const fileBuffer = await s3Service.getFile({
            media: attachment.media,
            bucket: attachment.bucket,
            region: attachment.region,
            buffer: true,
          });

          console.log('   ✓ File retrieved from source bucket');
          
          // Convert stream to buffer if needed
          let bufferData = fileBuffer;
          if (fileBuffer && typeof fileBuffer.transformToByteArray === 'function') {
            bufferData = await fileBuffer.transformToByteArray();
          } else if (fileBuffer && typeof fileBuffer.on === 'function') {
            const chunks = [];
            for await (const chunk of fileBuffer) {
              chunks.push(chunk);
            }
            bufferData = Buffer.concat(chunks);
          }
          
          console.log('   📤 Uploading to public bucket...');

          // Determine content type from mime_type or file extension
          let contentType = body.mime_type || attachment.content_type || 'application/octet-stream';
          
          // Map common extensions to MIME types if not provided
          if (!contentType || contentType === 'application/octet-stream') {
            const ext = fileExtension.toLowerCase();
            const mimeTypes = {
              'jpg': 'image/jpeg',
              'jpeg': 'image/jpeg',
              'png': 'image/png',
              'gif': 'image/gif',
              'pdf': 'application/pdf',
              'doc': 'application/msword',
              'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'xls': 'application/vnd.ms-excel',
              'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'ppt': 'application/vnd.ms-powerpoint',
              'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              'txt': 'text/plain',
              'mp4': 'video/mp4',
              'mp3': 'audio/mpeg',
            };
            contentType = mimeTypes[ext] || 'application/octet-stream';
          }

          // Generate S3 key for the file
          const s3Key = `${project._id}/drive-files/${attachment.name || attachment.media.split('/').pop()}`;
          
          // Upload directly to S3 with proper Content-Type and Content-Disposition
          const s3Client = new S3Client({ region: publicRegion });
          const uploadCommand = new PutObjectCommand({
            Bucket: publicBucket,
            Key: s3Key,
            Body: bufferData,
            ContentType: contentType,
            ContentDisposition: 'inline', // Makes browser display instead of download
          });

          await s3Client.send(uploadCommand);
          
          console.log('   ✓ File uploaded to public bucket with inline disposition');
          
          // Generate direct S3 URL
          const publicUrl = `https://${publicBucket}.s3.${publicRegion}.amazonaws.com/${s3Key}`;
          
          console.log('📁 File copied to public bucket successfully!');
          console.log('   📂 New Key:', s3Key);
          console.log('   🔗 Public URL:', publicUrl);
          console.log('   ✅ Content-Type:', contentType);
          console.log('   ✅ Content-Disposition: inline');
          console.log('');
          
          updatedAttachments.push({
            ...attachment,
            media: s3Key,
            bucket: publicBucket,
            region: publicRegion,
            public_url: publicUrl,
          });
        } else {
          console.log('⚠️  Skipping attachment - missing required fields (media, bucket, or region)');
          updatedAttachments.push(attachment);
        }
      } catch (error) {
        console.error('❌ Error copying attachment to public bucket:', error.message);
        console.error('   Error details:', {
          name: error.name,
          code: error.code,
          statusCode: error.$metadata?.httpStatusCode,
          sourceBucket: attachment.bucket,
          sourceRegion: attachment.region,
          sourceKey: attachment.media,
          targetBucket: publicBucket,
          targetRegion: publicRegion
        });
        // Keep original attachment if copy fails
        updatedAttachments.push(attachment);
      }
    }

    // Update file with new attachment information and share_url
    if (updatedAttachments.length > 0) {
      console.log('💾 Updating file document with', updatedAttachments.length, 'attachment(s)...');
      
      // Get the first attachment's public_url to set as share_url
      const shareUrl = updatedAttachments[0]?.public_url || '';
      
      await DriveFileRepository.updateFileDocument({
        filters: { _id: file._id },
        data: { 
          attachments: updatedAttachments,
          share_url: shareUrl,
        },
      });
      file.attachments = updatedAttachments;
      file.share_url = shareUrl;
      console.log('✅ File document updated with public URLs');
      console.log('✅ Share URL set:', shareUrl);
    }
  }

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

export default {
  createFile,
  getFiles,
  getFile,
  updateFile,
  deleteFile,
  moveFile,
  getFilesByType,
};
