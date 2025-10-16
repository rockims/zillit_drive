import BadRequest from 'zillit-libs/errors/BadRequest';
import NotificationService from 'zillit-libs/services-v2/notification';
import NotificationRepository from 'zillit-libs/repositories-v2/notification';
import { rights } from 'zillit-libs/services-v2/permissions';
import DriveFolderRepository from '../../repositories/v2/driveFolder.js';
import DriveFileRepository from '../../repositories/v2/driveFile.js';
import socketClient from '../../config/socketClient.js';

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

const createFolder = async ({ user, project, device, body, query }) => {
  // Trim and normalize the folder name for duplicate checking
  const normalizedFolderName = body.folder_name.trim().toLowerCase();

  // Check if a folder with the same name already exists in the same parent folder
  const filters = {
    project_id: project._id,
    parent_folder_id: body.parent_folder_id || null,
    deleted_on: 0,
  };

  const existingFolders = await DriveFolderRepository.getFolders({ filters });

  // Check for duplicate folder name (case-insensitive) in the same parent directory
  const duplicateFolder = existingFolders.find(folder =>
    folder.folder_name.trim().toLowerCase() === normalizedFolderName
  );

  if (duplicateFolder) {
    throw new BadRequest('duplicate_folder_name');
  }

  // Build folder path based on parent folder
  let folderPath = '';
  if (body.parent_folder_id) {
    const parentFolder = await DriveFolderRepository.getFolder({
      filters: { _id: body.parent_folder_id, project_id: project._id, deleted_on: 0 }
    });

    if (!parentFolder) {
      throw new BadRequest('parent_folder_not_found');
    }

    folderPath = parentFolder.folder_path ? `${parentFolder.folder_path}/${parentFolder.folder_name}` : parentFolder.folder_name;
  }

  // Determine if this is a folder or file based on attachments
  let isFolder = true;
  if (body.attachments && Array.isArray(body.attachments) && body.attachments.length > 0) {
    // If attachments are present and not empty, this is a file (is_folder = false)
    isFolder = false;
  }

  const data = {
    ...body,
    project_id: project._id,
    created_by: user._id,
    updated_by: user._id,
    folder_path: folderPath,
    is_folder: isFolder,
  };

  const folder = await DriveFolderRepository.createFolder({ data });

  // Get users with view access to the drive tool
  const usersIds = await _viewingRightsUsers(project);

  // // Send notification to users with view access
  // await NotificationService.notifyAll({
  //   data: folder,
  //   sectionId: sections.PROJECT,
  //   toolId: tools.DRIVE,
  //   unitId: units.FOLDER,
  //   message: `New folder "${folder.name}" created in ${project.name}`,
  //   receiverIds: usersIds,
  //   senderId: folder.created_by,
  //   projectId: project._id,
  //   organizationId: project.organization,
  // });

  // Emit socket event for real-time updates
  socketClient('__admin_events__', {
    event: 'folder:added',
    room: `${project._id.toString()}_room`,
    data: {
      project_id: project._id,
      device_id: device._id,
      folder: folder,
    },
  });

  return folder;
};

const getFolders = async ({ user, project, query }) => {
  const filters = {
    project_id: project._id,
    deleted_on: 0,
  };

  // If parent_folder_id is provided in query, filter by it
  if (query.parent_folder_id) {
    filters.parent_folder_id = query.parent_folder_id;
  } else if (query.parent_folder_id === null || query.root === 'true') {
    // Get root level folders (no parent)
    filters.parent_folder_id = null;
  }

  const sort = { created_on: -1 };
  const folders = await DriveFolderRepository.getFolders({ filters, sort });
  return folders;
};

const getFolder = async ({ project, params }) => {
  const filters = {
    _id: params.folderId,
    project_id: project._id,
    deleted_on: 0,
  };

  const folder = await DriveFolderRepository.getFolder({ filters });

  if (!folder) {
    throw new BadRequest('folder_not_found');
  }

  return folder;
};

const updateFolder = async ({ user, project, device, params, body }) => {
  const folderId = params.folderId || body.folder_id;

  if (!folderId) {
    throw new BadRequest('folder_id_required');
  }

  const filters = {
    _id: folderId,
    project_id: project._id,
    deleted_on: 0,
  };

  // First check if folder exists
  const existingFolder = await DriveFolderRepository.getFolder({ filters });
  if (!existingFolder) {
    throw new BadRequest('folder_not_found');
  }

  // If updating folder name, check for duplicates in the same parent directory
  if (body.folder_name && body.folder_name.trim().toLowerCase() !== existingFolder.folder_name.trim().toLowerCase()) {
    const normalizedFolderName = body.folder_name.trim().toLowerCase();

    const duplicateFilters = {
      project_id: project._id,
      parent_folder_id: existingFolder.parent_folder_id,
      deleted_on: 0,
      _id: { $ne: folderId } // Exclude current folder from duplicate check
    };

    const existingFolders = await DriveFolderRepository.getFolders({ filters: duplicateFilters });

    const duplicateFolder = existingFolders.find(folder =>
      folder.folder_name.trim().toLowerCase() === normalizedFolderName
    );

    if (duplicateFolder) {
      throw new BadRequest('duplicate_folder_name');
    }
  }

  // Remove folder_id from body if it exists (shouldn't be in update data)
  const { folder_id, ...bodyWithoutFolderId } = body;

  // Determine if this is a folder or file based on attachments
  let isFolder = existingFolder.is_folder; // Keep existing value by default
  if (bodyWithoutFolderId.attachments !== undefined) {
    if (Array.isArray(bodyWithoutFolderId.attachments) && bodyWithoutFolderId.attachments.length > 0) {
      isFolder = false;
    } else {
      isFolder = true;
    }
  }

  const updateData = {
    ...bodyWithoutFolderId,
    updated_by: user._id,
    updated_on: Date.now(),
    is_folder: isFolder,
  };

  const updatedFolder = await DriveFolderRepository.updateFolderDocument({ filters, data: updateData });

  if (!updatedFolder) {
    throw new BadRequest('folder_update_failed');
  }

  // Get users with view access to the drive tool
  const usersIds = await _viewingRightsUsers(project);

  // Send notification to users with view access
  await NotificationService.notifyAll({
    data: updatedFolder,
    sectionId: sections.PROJECT,
    toolId: tools.DRIVE,
    unitId: units.FOLDER,
    message: `Folder "${updatedFolder.name}" updated in ${project.name}`,
    receiverIds: usersIds,
    senderId: updatedFolder.updated_by,
    projectId: project._id,
    organizationId: project.organization,
  });

  // Emit socket event for real-time updates
  socketClient('__admin_events__', {
    event: 'folder:updated',
    room: `${project._id.toString()}_room`,
    data: {
      project_id: project._id,
      device_id: device._id,
      folder: updatedFolder,
    },
  });

  return updatedFolder;
};

const deleteFolder = async ({ user, project, device, params }) => {
  const filters = {
    _id: params.folderId,
    project_id: project._id,
    deleted_on: 0,
  };

  const folder = await DriveFolderRepository.getFolder({ filters });

  if (!folder) {
    throw new BadRequest('folder_not_found');
  }

  const deleteTimestamp = Date.now();
  const deleteData = {
    deleted_on: deleteTimestamp,
    updated_by: user._id,
    updated_on: deleteTimestamp,
  };

  // Get all files in this folder and delete them
  const files = await DriveFileRepository.getFiles({
    filters: {
      folder_id: folder._id,
      project_id: project._id,
      deleted_on: 0,
    }
  });

  // Delete all files in this folder
  if (files.length > 0) {
    for (const file of files) {
      await DriveFileRepository.deleteFile({
        filters: { _id: file._id },
        data: deleteData
      });
    }
  }

  // Get subfolders and recursively delete them
  const subfolders = await DriveFolderRepository.getFolders({
    filters: {
      parent_folder_id: folder._id,
      project_id: project._id,
      deleted_on: 0,
    }
  });

  // Recursively delete all subfolders (and their files)
  if (subfolders.length > 0) {
    for (const subfolder of subfolders) {
      await deleteFolder({
        user,
        project,
        device,
        params: { folderId: subfolder._id }
      });
    }
  }

  // Get folder data before deletion for notification
  const folderToDelete = await DriveFolderRepository.getFolder({ filters });

  // Finally delete the folder itself
  await DriveFolderRepository.deleteFolder({ filters, data: deleteData });

  // Get users with view access to the drive tool
  const usersIds = await _viewingRightsUsers(project);

  // Send notification to users with view access
  await NotificationService.notifyAll({
    data: folderToDelete,
    sectionId: sections.PROJECT,
    toolId: tools.DRIVE,
    unitId: units.FOLDER,
    message: `Folder "${folderToDelete.name}" deleted from ${project.name}`,
    receiverIds: usersIds,
    senderId: user._id,
    projectId: project._id,
    organizationId: project.organization,
  });

  // Emit socket event for real-time updates
  socketClient('__admin_events__', {
    event: 'folder:deleted',
    room: `${project._id.toString()}_room`,
    data: {
      project_id: project._id,
      device_id: device._id,
      folder: folderToDelete,
    },
  });

  return {
    message: 'Folder deleted successfully',
    deletedFiles: files.length,
    deletedSubfolders: subfolders.length
  };
};



const getFolderContents = async ({ project, params, query }) => {
  const folderId = params.folderId;

  // Get folder info
  const folderFilters = {
    _id: folderId,
    project_id: project._id,
    deleted_on: 0,
  };

  const folder = await DriveFolderRepository.getFolder({ filters: folderFilters });

  if (!folder) {
    throw new BadRequest('folder_not_found');
  }

  // Get subfolders
  const subfolderFilters = {
    parent_folder_id: folderId,
    project_id: project._id,
    deleted_on: 0,
  };

  const subfolders = await DriveFolderRepository.getFolders({
    filters: subfolderFilters,
    sort: { created_on: -1 }
  });

  // Get files in this folder
  const fileFilters = {
    folder_id: folderId,
    project_id: project._id,
    deleted_on: 0,
  };

  const files = await DriveFileRepository.getFiles({
    filters: fileFilters,
    sort: { created_on: -1 }
  });

  return {
    folder,
    subfolders,
    files,
  };
};

export default {
  createFolder,
  getFolders,
  getFolder,
  updateFolder,
  deleteFolder,
  getFolderContents,
};
