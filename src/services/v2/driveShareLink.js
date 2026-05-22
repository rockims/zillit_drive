import crypto from 'crypto';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import BadRequest from 'zillit-libs/errors/BadRequest';
import Forbidden from 'zillit-libs/errors/Forbidden';
import NotFound from 'zillit-libs/errors/NotFound';
// zillit-libs exports map declares SES under './services-v2/ses', not
// './services-v2/aws/ses' — the 'aws/' folder is hidden behind the alias.
import SesService from 'zillit-libs/services-v2/ses';

import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveShareLinkRepository from '../../repositories/v2/driveShareLink.js';
import DriveFileAccessService from './driveFileAccess.js';

/**
 * DriveShareLinkService
 *
 * Public share-via-email links for Drive files. Recipients (any email)
 * access the linked file in a browser viewer with NO Zillit signup
 * required — the URL token IS the credential.
 *
 * Authenticated endpoints (createShareLink, listShareLinks, revokeShareLink)
 * require the actor to be a Zillit user with edit permission on the file.
 *
 * Public endpoints (getViewerData, getStreamUrl, recordView) use the URL
 * token only — no moduledata, no project session — and enforce the
 * lifecycle gates (revoked, expires_on, max_views) on every call.
 */

/* ───────────── S3 client (presigned GET URLs for the viewer) ───────────── */

const S3_DEFAULT_REGION = process.env.AWS_REGION || 'ap-south-1';
const S3_BUCKET = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || 'zillit-drive';

const s3ClientCache = {};
const getS3Client = (region) => {
  const r = region || S3_DEFAULT_REGION;
  if (!s3ClientCache[r]) {
    s3ClientCache[r] = new S3Client({
      region: r,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3ClientCache[r];
};

/* ───────────── Constants ───────────── */

const STREAM_URL_EXPIRY_SECONDS = 300;      // 5 min — short window per request

/**
 * Resolve the public web origin for share-link URLs.
 *
 * Resolution order:
 *   1. PUBLIC_WEB_URL env var if set (lets ops override for any deploy)
 *   2. Derive from NODE_ENV:
 *        dev   → https://dev.zillit.com
 *        qa    → https://qa.zillit.com
 *        prod  → https://web.zillit.com
 *   3. Fallback: https://dev.zillit.com
 *
 * Computed at module load — restart the service if NODE_ENV changes.
 */
const resolvePublicWebUrl = () => {
  if (process.env.PUBLIC_WEB_URL) return process.env.PUBLIC_WEB_URL;

  const env = (process.env.NODE_ENV || '').toLowerCase();
  if (env === 'prod' || env === 'production') return 'https://web.zillit.com';
  if (env === 'qa') return 'https://qa.zillit.com';
  // dev / staging / unset all route to dev.zillit.com
  return 'https://dev.zillit.com';
};

const PUBLIC_BASE_URL = resolvePublicWebUrl();

const toIdString = (value) => (value ? value.toString() : null);

/* ───────────── Token generation ───────────── */

// 32-byte URL-safe random — enough entropy that brute-forcing the keyspace
// is computationally infeasible. Two different tokens per recipient:
//   - link token  : identifies the share link
//   - recipient token: identifies WHICH recipient is viewing (forensic)
const generateToken = () => crypto.randomBytes(24)
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

/* ───────────── Lifecycle / validation ───────────── */

/**
 * Validate a public-side request: token exists, link not revoked, not
 * expired, view quota not exhausted. Returns the link doc and (when
 * recipientToken is provided AND matches) the recipient sub-doc.
 */
const validatePublicToken = async ({ token, recipientToken }) => {
  if (!token) throw new BadRequest('share_link_invalid');

  const link = await DriveShareLinkRepository.findByToken({ token });
  if (!link) throw new NotFound('share_link_not_found');

  if (link.revoked) throw new Forbidden('share_link_revoked');
  if (link.expires_on > 0 && Date.now() > link.expires_on) {
    throw new Forbidden('share_link_expired');
  }
  if (link.max_views > 0 && link.view_count >= link.max_views) {
    throw new Forbidden('share_link_view_limit_exceeded');
  }

  let recipient = null;
  if (recipientToken) {
    recipient = link.recipients.find((r) => r.recipient_token === recipientToken) || null;
  }

  return { link, recipient };
};

/* ───────────── Watermark resolution ───────────── */

// Resolve the watermark template to the actual string the viewer overlays.
// Fixed template in MVP — recipient email + ISO timestamp. If recipient
// is missing (anonymous view), substitute "viewer" so we still get a
// timestamp watermark.
const resolveWatermark = ({ template, recipient }) => {
  const email = recipient?.email || 'viewer';
  const timestamp = new Date().toISOString();
  return (template || '{email} • {timestamp}')
    .replace('{email}', email)
    .replace('{timestamp}', timestamp);
};

/* ───────────── Email send ───────────── */

const buildEmailHtml = ({ link, recipient, file, sender }) => {
  const url = `${PUBLIC_BASE_URL}/share/${link.token}?r=${recipient.recipient_token}`;
  const senderName = sender?.full_name || sender?.first_name || sender?.email || 'A Zillit user';
  const expiryText = link.expires_on > 0
    ? `This link expires on ${new Date(link.expires_on).toUTCString()}.`
    : 'This link does not expire.';
  const message = link.message
    ? `<p style="margin:16px 0;color:#333;">${escapeHtml(link.message)}</p>`
    : '';

  return `
<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 16px;">${escapeHtml(senderName)} shared a file with you</h2>
  <p style="margin:0 0 8px;color:#555;">
    via <strong>Zillit Drive</strong>
  </p>
  <div style="border:1px solid #eee;border-radius:8px;padding:16px;margin:16px 0;background:#fafafa;">
    <div style="font-size:14px;color:#666;">File</div>
    <div style="font-size:16px;font-weight:600;margin-top:4px;">${escapeHtml(file.file_name)}</div>
    <div style="font-size:13px;color:#666;margin-top:8px;">
      Permission: ${link.permission === 'view' ? 'View only' : 'View &amp; download'}
    </div>
  </div>
  ${message}
  <p style="margin:24px 0;">
    <a href="${url}" style="display:inline-block;background:#f99300;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;">Open file</a>
  </p>
  <p style="margin:16px 0;font-size:12px;color:#666;">
    ${expiryText}<br>
    This link is for your use only. Your viewing activity is logged.
  </p>
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
  <p style="font-size:11px;color:#999;margin:0;">
    If you cannot click the button, paste this URL into your browser:<br>
    <span style="word-break:break-all;">${url}</span>
  </p>
</body></html>`;
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const sendShareEmail = async ({ link, recipient, file, sender }) => {
  try {
    const ses = new SesService({
      to: recipient.email,
      subject: `${sender?.full_name || sender?.email || 'A Zillit user'} shared "${file.file_name}" with you`,
      html: buildEmailHtml({
        link, recipient, file, sender,
      }),
    });
    await ses.sendEmail();
  } catch (err) {
    // Email failures are logged but non-fatal — the share link still
    // exists in the DB and can be re-sent (or the sender can copy the
    // URL manually from the ShareDrawer).
    // eslint-disable-next-line no-console
    console.error('[share_link_email_failed]:', err?.message || err);
  }
};

/* ───────────── Authenticated endpoints ───────────── */

const createShareLink = async ({ user, project, params, body }) => {
  const { fileId } = params;

  const file = await DriveFileRepository.getFile({
    filters: { _id: fileId, project_id: project._id, deleted_on: 0 },
  });
  if (!file) throw new NotFound('file_not_found');

  // Creating a share link is a write-equivalent action on the file —
  // require edit permission. (Anyone who can edit the file can share it;
  // a view-only collaborator should not be able to re-share externally.)
  await DriveFileAccessService.assertFileAccess({
    user, project, file, permission: 'edit',
  });

  const now = Date.now();
  const expires_on = body.expires_in_ms === 0 ? 0 : now + body.expires_in_ms;

  // Stamp a unique recipient_token per recipient up-front so we can use it
  // for the per-recipient URL in the outgoing email.
  const recipients = (body.recipients || []).map((r) => ({
    email: String(r.email || '').toLowerCase().trim(),
    recipient_token: generateToken(),
    sent_on: now,
  }));

  const link = await DriveShareLinkRepository.create({
    data: {
      project_id: project._id,
      item_type: 'file',
      item_id: file._id,
      token: generateToken(),
      permission: body.permission || 'view',
      created_by: user._id,
      created_on: now,
      updated_on: now,
      expires_on,
      max_views: body.max_views || 0,
      view_count: 0,
      revoked: false,
      recipients,
      message: body.message || '',
    },
  });

  // Fire off emails (non-blocking errors). Sender info is best-effort —
  // populated from the user document we already have.
  if (recipients.length > 0) {
    await Promise.all(recipients.map((recipient) => sendShareEmail({
      link, recipient, file, sender: user,
    })));
  }

  return {
    _id: link._id,
    token: link.token,
    url: `${PUBLIC_BASE_URL}/share/${link.token}`,   // "naked" URL — no recipient_token
    permission: link.permission,
    expires_on: link.expires_on,
    max_views: link.max_views,
    recipients: link.recipients.map((r) => ({
      email: r.email,
      recipient_token: r.recipient_token,
      url: `${PUBLIC_BASE_URL}/share/${link.token}?r=${r.recipient_token}`,
    })),
  };
};

const listShareLinks = async ({ user, project, params }) => {
  const { fileId } = params;

  const file = await DriveFileRepository.getFile({
    filters: { _id: fileId, project_id: project._id, deleted_on: 0 },
  });
  if (!file) throw new NotFound('file_not_found');

  // Listing existing share links requires view permission on the file
  // (you can see who you've shared it with even if you only have view).
  await DriveFileAccessService.assertFileAccess({
    user, project, file, permission: 'view',
  });

  const links = await DriveShareLinkRepository.findActiveByItem({
    project_id: project._id,
    item_id: file._id,
  });

  return links.map((link) => ({
    _id: link._id,
    token: link.token,
    permission: link.permission,
    created_on: link.created_on,
    expires_on: link.expires_on,
    max_views: link.max_views,
    view_count: link.view_count,
    recipients: link.recipients.map((r) => ({
      email: r.email,
      view_count: r.view_count,
      first_viewed_on: r.first_viewed_on,
      last_viewed_on: r.last_viewed_on,
    })),
  }));
};

const revokeShareLink = async ({ user, project, params }) => {
  const { linkId } = params;

  const link = await DriveShareLinkRepository.findById({ _id: linkId });
  if (!link || toIdString(link.project_id) !== toIdString(project._id)) {
    throw new NotFound('share_link_not_found');
  }
  if (link.revoked) return { _id: link._id, revoked: true };

  // Only the creator of the link OR a user with edit permission on the
  // underlying file can revoke it.
  if (toIdString(link.created_by) !== toIdString(user._id)) {
    const file = await DriveFileRepository.getFile({
      filters: { _id: link.item_id, project_id: project._id, deleted_on: 0 },
    });
    if (!file) throw new NotFound('file_not_found');
    await DriveFileAccessService.assertFileAccess({
      user, project, file, permission: 'edit',
    });
  }

  const updated = await DriveShareLinkRepository.updateById({
    _id: link._id,
    data: {
      revoked: true,
      revoked_on: Date.now(),
      revoked_by: user._id,
    },
  });

  return { _id: updated._id, revoked: true, revoked_on: updated.revoked_on };
};

/* ───────────── Public (token-only) endpoints ───────────── */

const getViewerData = async ({ params, query }) => {
  const { token } = params;
  const { r: recipientToken } = query;

  const { link, recipient } = await validatePublicToken({ token, recipientToken });

  const file = await DriveFileRepository.getFile({
    filters: { _id: link.item_id, project_id: link.project_id, deleted_on: 0 },
  });
  if (!file) throw new NotFound('file_not_found');

  return {
    file: {
      _id: file._id,
      file_name: file.file_name,
      file_type: file.file_type,
      file_extension: file.file_extension,
      file_size_bytes: file.file_size_bytes,
      mime_type: file.mime_type,
    },
    permission: link.permission,
    can_download: link.permission === 'view_download',
    watermark: resolveWatermark({ template: link.watermark_template, recipient }),
    expires_on: link.expires_on,
    // stream_url is fetched via the dedicated /stream endpoint so it's
    // always fresh (5min TTL each call) and the metadata response can be
    // cached longer by the client without expiring the media.
  };
};

const getStreamUrl = async ({ params, query, req }) => {
  const { token } = params;
  const { r: recipientToken } = query;

  const { link, recipient } = await validatePublicToken({ token, recipientToken });

  const file = await DriveFileRepository.getFile({
    filters: { _id: link.item_id, project_id: link.project_id, deleted_on: 0 },
  });
  if (!file) throw new NotFound('file_not_found');

  const s3Key = file.file_path
    || file.attachments?.[0]?.media
    || file.attachments?.[0]?.file_path;
  if (!s3Key) throw new BadRequest('file_has_no_storage_path');

  const attachment = file.attachments?.[0] || {};
  const bucket = attachment.bucket || S3_BUCKET;
  const region = attachment.region || S3_DEFAULT_REGION;
  const s3 = getS3Client(region);

  const cmdInput = {
    Bucket: bucket,
    Key: s3Key,
    // Content-Disposition: inline forces the browser to render the file
    // in-place (video plays, image displays, PDF previews) rather than
    // triggering a save dialog. Combined with controlsList="nodownload"
    // on the FE this blocks the casual download path.
    ResponseContentDisposition: `inline; filename="${encodeURIComponent(file.file_name || 'file')}"`,
  };
  if (file.mime_type) cmdInput.ResponseContentType = file.mime_type;

  const presignedUrl = await getSignedUrl(s3, new GetObjectCommand(cmdInput), {
    expiresIn: STREAM_URL_EXPIRY_SECONDS,
  });

  // Record the view here — fetching the stream URL is the moment of "the
  // recipient actually sees content". This is what counts against
  // max_views and is logged with IP/UA for forensic attribution.
  await DriveShareLinkRepository.recordView({
    _id: link._id,
    recipientToken,
    ip: req?.ip || req?.headers?.['x-forwarded-for'] || null,
    userAgent: req?.headers?.['user-agent'] || null,
  });

  return {
    stream_url: presignedUrl,
    expires_in: STREAM_URL_EXPIRY_SECONDS,
    permission: link.permission,
    watermark: resolveWatermark({ template: link.watermark_template, recipient }),
  };
};

const recordView = async ({ params, query, req }) => {
  // Companion endpoint for the FE viewer to ping when the page loads
  // (separate from /stream so analytics/heartbeat events don't burn
  // presigned URL allocations). Same validation gates.
  const { token } = params;
  const { r: recipientToken } = query;
  const { link } = await validatePublicToken({ token, recipientToken });

  await DriveShareLinkRepository.recordView({
    _id: link._id,
    recipientToken,
    ip: req?.ip || req?.headers?.['x-forwarded-for'] || null,
    userAgent: req?.headers?.['user-agent'] || null,
  });

  return { ok: true };
};

export default {
  createShareLink,
  listShareLinks,
  revokeShareLink,
  getViewerData,
  getStreamUrl,
  recordView,
};
