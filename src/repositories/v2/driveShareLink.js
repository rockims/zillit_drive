import DriveShareLink from 'zillit-libs/mongo-models-v2/DriveShareLink';

const create = ({ data }) => DriveShareLink.create(data);

const findByToken = ({ token }) => DriveShareLink.findOne({ token });

const findById = ({ _id }) => DriveShareLink.findOne({ _id });

const findActiveByItem = ({ project_id, item_id }) => DriveShareLink
  .find({ project_id, item_id, revoked: false })
  .sort({ created_on: -1 });

const updateById = ({ _id, data }) => DriveShareLink.findOneAndUpdate(
  { _id },
  { $set: { ...data, updated_on: Date.now() } },
  { new: true },
);

// Atomic counter increment + recipient sub-document update — avoids
// read-modify-write races when multiple recipients open the same link
// concurrently.
const recordView = ({ _id, recipientToken, ip, userAgent }) => {
  const now = Date.now();

  // Always bump the top-level counter
  const update = { $inc: { view_count: 1 }, $set: { updated_on: now } };

  if (recipientToken) {
    // Update the matching recipient sub-document
    return DriveShareLink.findOneAndUpdate(
      { _id, 'recipients.recipient_token': recipientToken },
      {
        ...update,
        $inc: { ...update.$inc, 'recipients.$.view_count': 1 },
        $set: {
          ...update.$set,
          'recipients.$.last_viewed_on': now,
        },
        ...(ip ? { $addToSet: { 'recipients.$.ip_addresses': ip } } : {}),
        ...(userAgent ? { $addToSet: { 'recipients.$.user_agents': userAgent } } : {}),
      },
      { new: true },
    ).then(async (doc) => {
      // Backfill first_viewed_on if this is the first view
      if (doc) {
        const recipient = doc.recipients.find((r) => r.recipient_token === recipientToken);
        if (recipient && !recipient.first_viewed_on) {
          await DriveShareLink.updateOne(
            { _id, 'recipients.recipient_token': recipientToken },
            { $set: { 'recipients.$.first_viewed_on': now } },
          );
        }
      }
      return doc;
    });
  }

  // Anonymous view (recipient token missing or unmatched) — just bump the
  // top-level counter so max_views enforcement still works.
  return DriveShareLink.findOneAndUpdate({ _id }, update, { new: true });
};

export default {
  create,
  findByToken,
  findById,
  findActiveByItem,
  updateById,
  recordView,
};
