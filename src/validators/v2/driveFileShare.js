import Joi from 'joi-oid';

const generateShareLink = Joi.object({
  expiresAt: Joi.date().optional().allow(null).error((err) => {
    err[0].message = 'expires_at_validation';
    return err;
  }),

  allowDownload: Joi.boolean().optional().default(true).error((err) => {
    err[0].message = 'allow_download_validation';
    return err;
  }),

  password: Joi.string().optional().allow(null).min(4).max(50).error((err) => {
    err[0].message = 'password_validation';
    return err;
  }),

  accessLevel: Joi.string().valid('view', 'download').optional().default('view').error((err) => {
    err[0].message = 'access_level_validation';
    return err;
  }),
});

const updateShareSettings = Joi.object({
  expiresAt: Joi.date().optional().allow(null).error((err) => {
    err[0].message = 'expires_at_validation';
    return err;
  }),

  allowDownload: Joi.boolean().optional().error((err) => {
    err[0].message = 'allow_download_validation';
    return err;
  }),

  password: Joi.string().optional().allow(null).min(4).max(50).error((err) => {
    err[0].message = 'password_validation';
    return err;
  }),

  accessLevel: Joi.string().valid('view', 'download').optional().error((err) => {
    err[0].message = 'access_level_validation';
    return err;
  }),
});

const accessSharedFile = Joi.object({
  password: Joi.string().optional().allow(null).error((err) => {
    err[0].message = 'password_validation';
    return err;
  }),
});

export default {
  generateShareLink,
  updateShareSettings,
  accessSharedFile,
};
