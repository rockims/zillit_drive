// Joi-oid (not joi-objectid) — that's the dep that's actually installed
// in zillit_drive's node_modules. Every other validator in this folder
// uses the same import — keep it consistent.
import Joi from 'joi-oid';

const createFileRequest = Joi.object({
  // Destination folder — required. Where uploads land.
  destination_folder_id: Joi.objectId().required().error((err) => {
    err[0].message = 'destination_folder_id_required';
    return err;
  }),

  title: Joi.string().trim().min(1).max(200).required().error((err) => {
    err[0].message = 'title_required';
    return err;
  }),

  description: Joi.string().trim().max(2000).allow('').default(''),
  thank_you_message: Joi.string().trim().max(1000).allow('').default(''),

  // ms duration from now. 0 = never. Cap at 1 year (matches share-link).
  expires_in_ms: Joi.number()
    .integer().min(0).max(365 * 24 * 60 * 60 * 1000)
    .default(7 * 24 * 60 * 60 * 1000),

  // 0 = unlimited
  max_files_per_session: Joi.number().integer().min(0).default(0),
  // Max bytes a single uploader can push in one session. 0 = unlimited.
  // Cap at 5 GB so a single recipient can't fill the project quota
  // through one file request.
  max_total_size_bytes: Joi.number().integer().min(0).max(5 * 1024 * 1024 * 1024)
    .default(0),

  // Empty array = any type. Each entry is a mime pattern: 'image/png',
  // 'image/*', 'application/pdf', etc.
  allowed_mime_patterns: Joi.array().items(Joi.string().trim().max(100))
    .max(20)
    .default([]),

  require_uploader_email: Joi.boolean().default(true),
  require_uploader_name: Joi.boolean().default(false),
});

// Body shape when the recipient starts an upload visit. Some fields
// are only required if the request was configured to require them —
// we keep them all optional here and re-validate against the request
// config in the service (cheaper than passing the request flags into
// joi at middleware time).
const startUploadSession = Joi.object({
  uploader_email: Joi.string().email().lowercase().trim().allow(''),
  uploader_name: Joi.string().trim().max(100).allow(''),
});

export default {
  createFileRequest,
  startUploadSession,
};
