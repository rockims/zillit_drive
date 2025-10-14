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

export default {
  createFolder,
  updateFolder,
};
