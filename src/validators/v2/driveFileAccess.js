import Joi from 'joi-oid';

const updateFileAccess = Joi.object({
  entries: Joi.array()
    .items(
      Joi.object({
        user_id: Joi.objectId().required(),
        can_view: Joi.boolean().default(true),
        can_edit: Joi.boolean().default(false),
        can_download: Joi.boolean().default(true),
      }),
    )
    .min(0)
    .required()
    .error((err) => {
      err[0].message = 'entries_validation';
      return err;
    }),
});

export default {
  updateFileAccess,
};
