import crypto from 'crypto';
import axios from 'axios';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import BadRequest from 'zillit-libs/errors/BadRequest';
import Forbidden from 'zillit-libs/errors/Forbidden';
import NotFound from 'zillit-libs/errors/NotFound';
import EncryptDecryptUtil from 'zillit-libs/utils/encrypt-decrypt';

import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveShareLinkRepository from '../../repositories/v2/driveShareLink.js';
import DriveFileAccessService from './driveFileAccess.js';
import DriveWopiService from './driveWopi.js';
import {
  COLLABORA_URL,
  WOPI_BASE_URL,
  EDITABLE_EXTENSIONS,
  getCollaboraEditorUrl,
} from './driveEditor.js';
import { getUrls } from './config.js';

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

/**
 * Send the share-link email through the email service's /v2/imap-send
 * endpoint — the same "distribution" pipeline used by zillit_script_distribution,
 * zillit_schedule_distribution, and PM's deal-memo flow.
 *
 * Benefit over direct SES: the email is dispatched from the sender's own
 * provisioned mailbox (user.mail_box_detail.email_address) instead of
 * info@zillit.com, which avoids same-domain anti-spoof rejections and lands
 * in the sender's "Distributed Mails" folder for audit.
 *
 * Caller must pass `moduledata` (the encrypted auth blob the route middleware
 * attaches to req.headers) — the email service uses it to authenticate the
 * inter-service call.
 *
 * Throws on failure so the caller can fall back to SES.
 */
const sendShareEmailViaDistribution = async ({
  link, recipient, file, sender, moduledata,
}) => {
  if (!sender?.mail_box_detail?.email_address || !sender?.mail_box_detail?.id) {
    // Sender has no mailbox — caller should fall back to SES.
    throw new Error('sender_has_no_mailbox');
  }
  if (!moduledata) {
    throw new Error('moduledata_required_for_imap_send');
  }

  const payload = {
    from: `${sender.mail_box_detail.name || sender.full_name || ''} <${sender.mail_box_detail.email_address}>`.trim(),
    to: [{ email_address: recipient.email }],
    cc: [],
    bcc: [],
    subject: `${sender?.full_name || sender?.email || 'A Zillit user'} shared "${file.file_name}" with you`,
    body: buildEmailHtml({
      link, recipient, file, sender,
    }),
    storage_folder: 'Distributed Mails',
  };

  const bodyhash = new EncryptDecryptUtil().hashWithSHA256(
    JSON.stringify({ payload, moduledata }),
  );

  await axios.request({
    method: 'post',
    maxBodyLength: Infinity,
    url: `${getUrls('CNC_BASE_URL')}/v2/imap-send`,
    headers: { moduledata, bodyhash },
    data: payload,
  });
};

/**
 * Top-level send. Tries the distribution path first (sender mailbox →
 * imap-send through emailapi). No SES fallback: in practice emailapi
 * returns `400 email_sent_failed` AFTER MailSlurp has already queued the
 * message — falling back to SES at that point delivered a second copy
 * (observed during dev QA). Treating the distribution path as the single
 * source of truth keeps it one email per recipient.
 *
 * If the sender has no provisioned mailbox, we deliberately fail the send
 * loud and log it — share linking is a write-equivalent action and
 * `mail_box_detail` should always be present for any user with edit access
 * to a file. A missing mailbox indicates a misconfigured account, not a
 * normal flow.
 *
 * The share link is already persisted before this fires, so even if the
 * send fails the sender can still copy the URL manually from the
 * ShareDrawer.
 */
const sendShareEmail = async ({
  link, recipient, file, sender, moduledata,
}) => {
  // Positive visibility: which path are we about to try, and why?
  // Without this, a silent success is indistinguishable from a no-op when
  // debugging "the email never arrived". The cost is one log line per send.
  // eslint-disable-next-line no-console
  console.info('[share_link_email_attempt]:', {
    to: recipient.email,
    sender_id: String(sender?._id || ''),
    sender_email: sender?.email,
    has_mailbox: !!(sender?.mail_box_detail?.id),
    has_moduledata: !!moduledata,
  });

  // Skip if we can't do the distribution send. Don't fall back to SES —
  // SES (info@zillit.com → @zillit.com) gets dropped by anti-spoof, and
  // a successful-but-undelivered send is worse than a logged skip.
  if (!sender?.mail_box_detail?.id) {
    // eslint-disable-next-line no-console
    console.warn('[share_link_email_skipped_no_mailbox]:', {
      to: recipient.email, sender_id: String(sender?._id || ''),
    });
    return;
  }
  if (!moduledata) {
    // eslint-disable-next-line no-console
    console.warn('[share_link_email_skipped_no_moduledata]:', {
      to: recipient.email,
    });
    return;
  }

  try {
    await sendShareEmailViaDistribution({
      link, recipient, file, sender, moduledata,
    });
    // eslint-disable-next-line no-console
    console.info('[share_link_email_sent_via_distribution]:', {
      to: recipient.email, from: sender.mail_box_detail.email_address,
    });
  } catch (err) {
    // emailapi /v2/imap-send often returns 400 `email_sent_failed` AFTER
    // MailSlurp has already accepted the message — so a "failure" here is
    // typically not a true delivery failure. Log loudly but don't retry.
    // eslint-disable-next-line no-console
    console.warn('[share_link_email_distribution_failed]:', {
      to: recipient.email,
      error: err?.response?.data?.message || err?.message || String(err),
    });
  }
};

/* ───────────── Authenticated endpoints ───────────── */

const createShareLink = async ({ user, project, params, body, moduledata }) => {
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
  // populated from the user document we already have. moduledata is
  // forwarded so the distribution path can re-authenticate against emailapi.
  if (recipients.length > 0) {
    await Promise.all(recipients.map((recipient) => sendShareEmail({
      link, recipient, file, sender: user, moduledata,
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

/**
 * Server-side proxy stream for the underlying file.
 *
 * Unlike `getStreamUrl` (which returns a 5-min presigned S3 URL the
 * client can copy from devtools to grab raw file access), this endpoint
 * streams the S3 object body THROUGH drive. The browser's `<video src>`
 * / `<img src>` / `<iframe src>` points at this drive endpoint instead
 * of S3, so:
 *
 *   - No presigned URL is ever exposed to the client
 *   - Every byte served goes through the share-link auth gate
 *     (revoked / expired / max_views — same as the rest of the public
 *     endpoints)
 *   - Range requests (video seeking) are forwarded to S3 so playback
 *     behaviour is identical to the presigned-URL path
 *
 * Anti-leak: an attacker who copies the proxy URL from devtools still
 * gets a URL that depends on the share-link token. Revoking the link
 * kills all future access; the URL has no value outside the link's
 * lifetime.
 */
const streamContent = async ({ params, query, req, res }) => {
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

  // Forward Range from client → S3 so video seeking works. Without this
  // the entire object is streamed for every play position which makes
  // mid-file seeks unusable on large files.
  const rangeHeader = req?.headers?.range;
  const cmdInput = { Bucket: bucket, Key: s3Key };
  if (rangeHeader) cmdInput.Range = rangeHeader;

  const s3Response = await s3.send(new GetObjectCommand(cmdInput));

  // Forward content metadata so the browser treats the stream identically
  // to a direct S3 fetch.
  if (file.mime_type) res.setHeader('Content-Type', file.mime_type);
  if (s3Response.ContentLength) res.setHeader('Content-Length', s3Response.ContentLength);
  if (s3Response.ContentRange) res.setHeader('Content-Range', s3Response.ContentRange);
  if (s3Response.AcceptRanges) res.setHeader('Accept-Ranges', s3Response.AcceptRanges);
  if (s3Response.ETag) res.setHeader('ETag', s3Response.ETag);

  // Cross-Origin-Resource-Policy: cross-origin
  //
  // Helmet's default sets CORP to 'same-origin' app-wide, which blocks
  // <video src>, <img src>, <iframe src> from cross-origin pages (the
  // public viewer at https://*.zillit.com fetching from this api host).
  // CORS alone is NOT enough for media embed — the browser enforces
  // CORP separately. We override to 'cross-origin' here so the public
  // viewer can actually render the stream.
  //
  // Auth is unaffected: every byte still flows through
  // validatePublicToken (revoked / expired / max_views gates).
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  // Inline disposition — same as the presigned URL config, prevents the
  // browser from offering a Save dialog when the URL is opened directly.
  const safeName = encodeURIComponent(file.file_name || 'file');
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);

  // 206 Partial Content if we forwarded a Range; 200 otherwise.
  res.status(rangeHeader && s3Response.ContentRange ? 206 : 200);

  // Record the view ONLY on initial (non-Range, or Range starts at 0)
  // requests — video players issue many Range fetches for seek/buffer
  // and we don't want each one to bump view_count.
  const isInitialRequest = !rangeHeader || /^bytes=0-/.test(rangeHeader);
  if (isInitialRequest) {
    // Fire-and-forget so the response stream isn't gated on the DB write.
    DriveShareLinkRepository.recordView({
      _id: link._id,
      recipientToken,
      ip: req?.ip || req?.headers?.['x-forwarded-for'] || null,
      userAgent: req?.headers?.['user-agent'] || null,
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[share_link_recordview_failed]:', err?.message || err);
    });
  }

  // Pipe S3 body directly to the response stream. Will close the response
  // when the underlying stream ends or errors.
  s3Response.Body.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[share_link_stream_pipe_failed]:', err?.message || err);
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy(err);
    }
  });
  s3Response.Body.pipe(res);

  // signal to controller not to call handleResponse — we're handling res
  // directly.
  return null;
};

/**
 * Office viewer config for public share-link recipients.
 *
 * When the shared file is a Collabora-supported Office format (docx,
 * xlsx, pptx, etc.) the public viewer in zillit_web embeds Collabora
 * Online in an iframe to render it — same WOPI host (drive) that the
 * in-app editor uses, just with a public-share access token.
 *
 * Returns the config the FE needs to build the iframe URL:
 *   ${collaboraUrl}/browser/.../cool.html?WOPISrc=...&access_token=...
 *
 * Security:
 *   - `canEdit: false` is hard-coded in the WOPI token → PutFile is
 *     refused by drive's WOPI host (existing permission check at
 *     driveWopi.js:175).
 *   - `canDownload: false` → CheckFileInfo sets DisablePrint,
 *     DisableExport, HideExportOption, HidePrintOption — Collabora
 *     hides the download/print/export menus.
 *   - The recipient's email becomes the `UserFriendlyName` Collabora
 *     displays in its UI corner, providing soft attribution.
 */
const getOfficeViewerConfig = async ({ params, query, req }) => {
  const { token } = params;
  const { r: recipientToken } = query;

  const { link, recipient } = await validatePublicToken({ token, recipientToken });

  const file = await DriveFileRepository.getFile({
    filters: { _id: link.item_id, project_id: link.project_id, deleted_on: 0 },
  });
  if (!file) throw new NotFound('file_not_found');

  const ext = (file.file_extension || '').toLowerCase().replace(/^\./, '');
  if (!EDITABLE_EXTENSIONS.includes(ext)) {
    throw new BadRequest('file_type_not_collabora_viewable');
  }

  // Generate a public-share-flavoured WOPI access token. Hard-codes
  // canEdit:false and canDownload:false so this branch can't be used
  // to exfiltrate or modify, even with a leaked recipient link.
  const { token: accessToken, ttl: accessTokenTTL } = DriveWopiService
    .generatePublicShareAccessToken({
      link,
      recipient,
      project: { _id: link.project_id },
      file,
    });

  const wopiSrc = `${WOPI_BASE_URL}/wopi/files/${file._id}`;
  const editorUrl = await getCollaboraEditorUrl();

  // Record the view here — opening the Collabora viewer is the moment
  // the recipient sees the content (same semantics as getStreamUrl for
  // images/videos/PDFs).
  await DriveShareLinkRepository.recordView({
    _id: link._id,
    recipientToken,
    ip: req?.ip || req?.headers?.['x-forwarded-for'] || null,
    userAgent: req?.headers?.['user-agent'] || null,
  });

  return {
    collabora_url: COLLABORA_URL,
    editor_url: editorUrl,
    wopi_src: wopiSrc,
    access_token: accessToken,
    access_token_ttl: accessTokenTTL,
    file_name: file.file_name,
    file_type: ext,
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
  streamContent,
  getOfficeViewerConfig,
  recordView,
};
