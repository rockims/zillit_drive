import Joi from 'joi-oid';

const initiateUpload = Joi.object({
  file_name: Joi.string().required().trim().error((err) => {
    err[0].message = 'file_name_validation';
    return err;
  }),

  // Allow 0-byte files (industry-standard — Google Drive / Dropbox / OneDrive
  // all accept them). 0-byte uploads bypass S3 multipart in initiateUpload
  // and resolve directly via a synthetic completion. Max stays at 10 GB.
  file_size_bytes: Joi.number().integer().min(0).max(10 * 1024 * 1024 * 1024).required()
    .error((err) => {
      err[0].message = 'file_size_bytes_validation';
      return err;
    }),

  folder_id: Joi.objectId().optional().allow(null).error((err) => {
    err[0].message = 'folder_id_validation';
    return err;
  }),

  mime_type: Joi.string().allow('').optional().error((err) => {
    err[0].message = 'mime_type_validation';
    return err;
  }),

  description: Joi.string().allow('').optional().error((err) => {
    err[0].message = 'description_validation';
    return err;
  }),

  file_access: Joi.array()
    .items(
      Joi.object({
        user_id: Joi.objectId().required(),
        can_view: Joi.boolean().default(true),
        can_edit: Joi.boolean().default(false),
        can_download: Joi.boolean().default(true),
      }),
    )
    .optional()
    .default([])
    .error((err) => {
      err[0].message = 'file_access_validation';
      return err;
    }),
});

const completeUpload = Joi.object({
  // Allow an empty parts array — 0-byte uploads finalize with no parts
  // (initiateUpload skipped S3 multipart, so there's nothing to assemble).
  // For non-zero uploads the service still rejects an empty parts array.
  parts: Joi.array()
    .items(
      Joi.object({
        part_number: Joi.number().integer().min(1).required(),
        etag: Joi.string().required(),
      }),
    )
    .min(0)
    .required()
    .error((err) => {
      err[0].message = 'parts_validation';
      return err;
    }),

  file_name: Joi.string().trim().optional().error((err) => {
    err[0].message = 'file_name_validation';
    return err;
  }),

  description: Joi.string().allow('').optional().error((err) => {
    err[0].message = 'description_validation';
    return err;
  }),
});

export default {
  initiateUpload,
  completeUpload,
};
