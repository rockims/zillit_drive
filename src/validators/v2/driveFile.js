import Joi from 'joi-oid';

const attachmentSchema = Joi.object({
  media: Joi.string().allow('').optional(),
  name: Joi.string().allow('').optional(),
  thumbnail: Joi.string().allow('').optional(),
  content_type: Joi.string().allow('').optional(),
  content_subtype: Joi.string().allow('').optional(),
  caption: Joi.string().allow('').optional(),
  duration: Joi.number().optional(),
  height: Joi.number().optional(),
  width: Joi.number().optional(),
  bucket: Joi.string().allow('').optional(),
  region: Joi.string().allow('').optional(),
  created: Joi.number().optional(),
  file_size: Joi.string().allow('').optional(),
  content_id: Joi.string().allow('').optional(),
});

const createFile = Joi.object({
  file_name: Joi.string().required().trim().error((err) => {
    err[0].message = 'file_name_validation';
    return err;
  }),

  folder_id: Joi.objectId().optional().allow(null).error((err) => {
    err[0].message = 'folder_id_validation';
    return err;
  }),

  file_path: Joi.string().allow('').optional().error((err) => {
    err[0].message = 'file_path_validation';
    return err;
  }),

  description: Joi.string().allow('').optional().error((err) => {
    err[0].message = 'description_validation';
    return err;
  }),

  file_type: Joi.string().allow('').optional().error((err) => {
    err[0].message = 'file_type_validation';
    return err;
  }),

  file_extension: Joi.string().allow('').optional().error((err) => {
    err[0].message = 'file_extension_validation';
    return err;
  }),

  file_size: Joi.string().allow('').optional().error((err) => {
    err[0].message = 'file_size_validation';
    return err;
  }),

  file_size_bytes: Joi.number().optional().error((err) => {
    err[0].message = 'file_size_bytes_validation';
    return err;
  }),

  mime_type: Joi.string().allow('').optional().error((err) => {
    err[0].message = 'mime_type_validation';
    return err;
  }),

  attachments: Joi.array().items(attachmentSchema).optional().error((err) => {
    err[0].message = 'attachments_validation';
    return err;
  }),
});

const updateFile = Joi.object({
  file_id: Joi.objectId().optional().error((err) => {
    err[0].message = 'file_id_validation';
    return err;
  }),

  file_name: Joi.string().trim().optional().error((err) => {
    err[0].message = 'file_name_validation';
    return err;
  }),

  folder_id: Joi.objectId().optional().allow(null).error((err) => {
    err[0].message = 'folder_id_validation';
    return err;
  }),

  file_path: Joi.string().allow('').optional().error((err) => {
    err[0].message = 'file_path_validation';
    return err;
  }),

  description: Joi.string().allow('').optional().error((err) => {
    err[0].message = 'description_validation';
    return err;
  }),

  file_type: Joi.string().allow('').optional().error((err) => {
    err[0].message = 'file_type_validation';
    return err;
  }),

  file_extension: Joi.string().allow('').optional().error((err) => {
    err[0].message = 'file_extension_validation';
    return err;
  }),

  file_size: Joi.string().allow('').optional().error((err) => {
    err[0].message = 'file_size_validation';
    return err;
  }),

  file_size_bytes: Joi.number().optional().error((err) => {
    err[0].message = 'file_size_bytes_validation';
    return err;
  }),

  mime_type: Joi.string().allow('').optional().error((err) => {
    err[0].message = 'mime_type_validation';
    return err;
  }),

  attachments: Joi.array().items(attachmentSchema).optional().error((err) => {
    err[0].message = 'attachments_validation';
    return err;
  }),
});

const moveFile = Joi.object({
  target_folder_id: Joi.objectId().optional().allow(null).error((err) => {
    err[0].message = 'target_folder_id_validation';
    return err;
  }),
});

export default {
  createFile,
  updateFile,
  moveFile,
};
