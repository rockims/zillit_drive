import DriveActivityService from './driveActivity.js';
import DriveVersionDiffQueue from './driveVersionDiffQueue.js';
import socketClient from '../../config/socketClient.js';

/**
 * What follows every saved version, whichever editor made it: queue its
 * comparison, refresh open file lists and history panels, log the edit.
 */
const announceSavedVersion = ({
  projectId, userId, file, version, source,
}) => {
  DriveVersionDiffQueue.kick();

  // Real-time refresh for the file list and any open history panel
  socketClient('__admin_events__', {
    event: 'drive:file:updated',
    room: `${projectId}_room`,
    data: {
      project_id: projectId,
      file_id: file._id,
      action: 'editor_save',
      version_id: version._id,
    },
  });
  socketClient('__admin_events__', {
    event: 'drive:version:created',
    room: `${projectId}_room`,
    data: {
      project_id: projectId,
      file_id: file._id,
      version_id: version._id,
      version_number: version.version_number,
      saved_by: userId,
      save_type: version.save_type,
    },
  });

  // Log activity (fire-and-forget)
  DriveActivityService.log({
    projectId,
    userId,
    action: 'file_updated',
    itemId: file._id,
    itemType: 'file',
    itemName: file.file_name,
    details: { source, version_number: version.version_number },
  });
};

export { announceSavedVersion };

export default { announceSavedVersion };
