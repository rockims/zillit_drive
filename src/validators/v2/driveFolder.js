import Joi from 'joi-oid';

// Attachment schema for validation
const attachmentSchema = Joi.object({
  media: Joi.string().optional(),
  name: Joi.string().optional(),
  thumbnail: Joi.string().optional(),
  content_type: Joi.string().valid('document', 'image', 'audio', 'video').optional(),
  content_subtype: Joi.string().optional(),
  caption: Joi.string().optional(),
  duration: Joi.number().optional(),
  height: Joi.number().optional(),
  width: Joi.number().optional(),
  bucket: Joi.string().optional(),
  region: Joi.string().optional(),
  created: Joi.number().optional(),
  file_size: Joi.string().optional(),
  content_id: Joi.string().optional(),
});

const createFolder = Joi.object({
  folder_name: Joi.string().required().trim().error((err) => {
    err[0].message = 'folder_name_validation';
    return err;
  }),

  parent_folder_id: Joi.objectId().optional().allow(null).error((err) => {
    err[0].message = 'parent_folder_id_validation';
    return err;
  }),

  description: Joi.string().allow('').optional().error((err) => {
    err[0].message = 'description_validation';
    return err;
  }),

  attachments: Joi.array().items(attachmentSchema).optional().error((err) => {
    err[0].message = 'attachments_validation';
    return err;
  }),

});

const updateFolder = Joi.object({
  folder_id: Joi.objectId().optional().error((err) => {
    err[0].message = 'folder_id_validation';
    return err;
  }),

  folder_name: Joi.string().trim().optional().error((err) => {
    err[0].message = 'folder_name_validation';
    return err;
  }),

  parent_folder_id: Joi.objectId().optional().allow(null).error((err) => {
    err[0].message = 'parent_folder_id_validation';
    return err;
  }),

  description: Joi.string().allow('').optional().error((err) => {
    err[0].message = 'description_validation';
    return err;
  }),

  attachments: Joi.array().items(attachmentSchema).optional().error((err) => {
    err[0].message = 'attachments_validation';
    return err;
  }),
});

const updateFolderAccess = Joi.object({
  entries: Joi.array().items(
    Joi.object({
      user_id: Joi.objectId().required().error((err) => {
        err[0].message = 'folder_access_user_id_validation';
        return err;
      }),
      role: Joi.string().valid('owner', 'editor', 'viewer').required().error((err) => {
        err[0].message = 'folder_access_role_validation';
        return err;
      }),
    })
  ).min(1).required().error((err) => {
    err[0].message = 'folder_access_entries_validation';
    return err;
  }),
  replace_existing: Joi.boolean().optional(),
});

const inheritFolderAccess = Joi.object({
  trigger: Joi.boolean().optional(),
});

const moveFolder = Joi.object({
  target_folder_id: Joi.objectId().optional().allow(null).error((err) => {
    err[0].message = 'target_folder_id_validation';
    return err;
  }),
});

export default {
  createFolder,
  updateFolder,
  updateFolderAccess,
  inheritFolderAccess,
  moveFolder,
};
