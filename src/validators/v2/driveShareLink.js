// Use joi-oid like the rest of zillit_drive — it re-exports Joi with
// .objectId() attached. The earlier `joi-objectid` side-effect import was
// wrong: that package isn't in zillit_drive's deps and crashes at require().
import Joi from 'joi-oid';

const createShareLink = Joi.object({
  // Optional. When provided, backend records the recipients on the link
  // (each gets a unique recipient_token) and triggers the email send.
  // When omitted, a "naked" link is created — useful for copy-paste sharing
  // without an email send.
  recipients: Joi.array()
    .items(
      Joi.object({
        email: Joi.string().email().required().error((err) => {
          err[0].message = 'recipient_email_validation';
          return err;
        }),
      }),
    )
    .max(50)                          // sanity cap
    .optional()
    .error((err) => {
      err[0].message = 'recipients_validation';
      return err;
    }),

  permission: Joi.string()
    .valid('view', 'view_download')
    .default('view')
    .error((err) => {
      err[0].message = 'permission_validation';
      return err;
    }),

  // Pre-set lifetime options to keep the API surface tight. Values are ms
  // durations from now; service resolves to absolute expires_on.
  // 0 = never expires.
  expires_in_ms: Joi.number()
    .integer()
    .min(0)
    .max(365 * 24 * 60 * 60 * 1000)   // max 1 year
    .default(7 * 24 * 60 * 60 * 1000) // default 7 days
    .error((err) => {
      err[0].message = 'expires_in_ms_validation';
      return err;
    }),

  max_views: Joi.number()
    .integer()
    .min(0)
    .max(10000)
    .default(0)                       // 0 = unlimited
    .error((err) => {
      err[0].message = 'max_views_validation';
      return err;
    }),

  message: Joi.string().max(2000).allow('').optional(),
});

// Bulk variant — N file_ids in the body (instead of one fileId in the
// path) and ONE consolidated email per recipient covering all the files.
// Same per-link options as createShareLink (permission / expiry /
// max_views / message / recipients), just multiplexed.
const bulkCreateShareLinks = Joi.object({
  file_ids: Joi.array()
    .items(Joi.objectId().required())
    .min(1)
    .max(100)
    .required()
    .error((err) => { err[0].message = 'file_ids_validation'; return err; }),

  recipients: Joi.array()
    .items(
      Joi.object({
        email: Joi.string().email().required().error((err) => {
          err[0].message = 'recipient_email_validation';
          return err;
        }),
      }),
    )
    .max(50)
    .optional()
    .error((err) => { err[0].message = 'recipients_validation'; return err; }),

  permission: Joi.string()
    .valid('view', 'view_download')
    .default('view'),

  expires_in_ms: Joi.number()
    .integer()
    .min(0)
    .max(365 * 24 * 60 * 60 * 1000)
    .default(7 * 24 * 60 * 60 * 1000),

  max_views: Joi.number().integer().min(0).max(10000).default(0),

  message: Joi.string().max(2000).allow('').optional(),
});

export default {
  createShareLink,
  bulkCreateShareLinks,
};
