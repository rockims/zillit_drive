import Joi from 'joi-oid';

const attachmentSchema = Joi.object({
  url: Joi.string().allow('').optional(),
  bucket: Joi.string().allow('').optional(),
  key: Joi.string().allow('').optional(),
  cdn_url: Joi.string().allow('').optional(),
  original_name: Joi.string().allow('').optional(),
  size: Joi.number().optional(),
  mime_type: Joi.string().allow('').optional(),
  encoding: Joi.string().allow('').optional(),
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

  attachment: attachmentSchema.optional().error((err) => {
    err[0].message = 'attachment_validation';
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

  attachment: attachmentSchema.optional().error((err) => {
    err[0].message = 'attachment_validation';
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
