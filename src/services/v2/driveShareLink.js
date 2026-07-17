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

// Prefer S3_REGION (ap-south-1 on prod) over SDK-global AWS_REGION
// (us-east-1) — see driveFileRequest.js for the full rationale. The
// proxy streamContent does a direct server-side GetObject, so it needs
// the right region to avoid a 301.
const S3_DEFAULT_REGION = process.env.S3_REGION
  || process.env.AWS_S3_BUCKET_REGION
  || process.env.AWS_REGION
  || 'ap-south-1';
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
// ZL-20198: the watermark identifies WHO is viewing (recipient email for an
// email share, or "viewer" for an anonymous copy-paste link) and WHO shared it
// (the sender's name, baked into the template at creation — see
// createShareLink). The previous format appended an ISO timestamp ("email • ISO
// date/time"), which QA flagged as ugly and not what's wanted; we no longer add
// a timestamp. Legacy links created before this change still carry a
// `{timestamp}` token in their stored template, so we strip it here too.
const resolveWatermark = ({ template, recipient }) => {
  const who = recipient?.email || 'viewer';
  return (template || '{email}')
    .replace('{email}', who)
    // Drop any legacy `{timestamp}` token (and a leading separator like " • ").
    .replace(/\s*[•·|\-]?\s*\{timestamp\}/g, '')
    .replace('{timestamp}', '')
    .trim();
};

/* ───────────── Email send ───────────── */

const DISTRIBUTED_FOLDER = 'Distributed Mails';

/**
 * Make sure the sender's mailbox has the "Distributed Mails" IMAP folder
 * before we send with `storage_folder` pointing at it — same guard the
 * document-distribution service runs before its sends. Lists the folders
 * via /v2/imap-folders and creates the folder only when missing.
 */
const ensureDistributedFolder = async (moduledata) => {
  const baseUrl = getUrls('CNC_BASE_URL');
  const encryptor = new EncryptDecryptUtil();

  const listHash = encryptor.hashWithSHA256(JSON.stringify({ payload: '', moduledata }));
  const { data: folderResponse } = await axios.request({
    method: 'get',
    maxBodyLength: Infinity,
    url: `${baseUrl}/v2/imap-folders`,
    headers: { moduledata, bodyhash: listHash },
  });

  const exists = folderResponse?.data?.some((f) => f.folder_name === DISTRIBUTED_FOLDER);
  if (exists) return;

  const payload = { folder_name: DISTRIBUTED_FOLDER };
  const createHash = encryptor.hashWithSHA256(JSON.stringify({ payload, moduledata }));
  await axios.request({
    method: 'post',
    maxBodyLength: Infinity,
    url: `${baseUrl}/v2/imap-folders`,
    headers: { moduledata, bodyhash: createHash },
    data: payload,
  });
};

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

  // Non-fatal: a folder-listing hiccup shouldn't block the share email —
  // imap-send still delivers, worst case the copy isn't filed in the folder.
  try {
    await ensureDistributedFolder(moduledata);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[drive-share] ensure Distributed Mails folder failed: ${err.message || err}`);
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
    storage_folder: DISTRIBUTED_FOLDER,
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

  // ZL-20198: bake the sender's display name into the watermark template at
  // creation so the viewer overlay reads "<recipient email / viewer> • Shared
  // by <sender name>" — no date/time. Resolved from the creator we already have
  // (same fallback chain the share email uses).
  const senderWatermarkName = user?.full_name || user?.first_name || user?.email || 'a Zillit user';
  const watermarkTemplate = `{email} • Shared by ${senderWatermarkName}`;

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
      watermark_template: watermarkTemplate,
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

/* ───────────── Bulk: N files → 1 consolidated email per recipient ─────────── */

// HTML body for the consolidated email: one "Open file" row per file,
// each row's URL uses THIS recipient's per-file recipient_token (so
// the forensic watermark on playback stays per-recipient even when the
// same recipient receives many files in one go).
const buildConsolidatedEmailHtml = ({
  fileRows, sender, message, expires_on,
}) => {
  const senderName = sender?.full_name || sender?.first_name || sender?.email || 'A Zillit user';
  const count = fileRows.length;
  const expiryText = expires_on > 0
    ? `Links expire on ${new Date(expires_on).toUTCString()}.`
    : 'Links do not expire.';
  const messageBlock = message
    ? `<p style="margin:16px 0;color:#333;">${escapeHtml(message)}</p>`
    : '';

  const rowsHtml = fileRows.map((row) => `
    <div style="border:1px solid #eee;border-radius:8px;padding:12px 16px;margin:10px 0;background:#fafafa;">
      <div style="font-size:14px;font-weight:600;color:#111;margin-bottom:6px;">${escapeHtml(row.file_name)}</div>
      <div style="font-size:12px;color:#666;margin-bottom:10px;">
        Permission: ${row.permission === 'view' ? 'View only' : 'View &amp; download'}
      </div>
      <a href="${row.url}" style="display:inline-block;background:#f99300;color:#fff;text-decoration:none;padding:8px 16px;border-radius:6px;font-weight:600;font-size:13px;">Open file</a>
    </div>`).join('');

  return `
<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:640px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 16px;">${escapeHtml(senderName)} shared ${count} file${count === 1 ? '' : 's'} with you</h2>
  <p style="margin:0 0 8px;color:#555;">
    via <strong>Zillit Drive</strong>
  </p>
  ${messageBlock}
  <div style="margin:16px 0;">
    ${rowsHtml}
  </div>
  <p style="margin:16px 0;font-size:12px;color:#666;">
    ${expiryText}<br>
    These links are for your use only. Your viewing activity is logged.
  </p>
</body></html>`;
};

/**
 * Send one consolidated share email to a recipient containing rows for
 * ALL the files they were just shared. Mirrors sendShareEmailViaDistribution
 * (same auth, same headers, same emailapi route) but the body lists many
 * files instead of one. Treats emailapi's `email_sent_failed` 400 as a
 * successful send — verified false-negative in this codebase (see PR #94's
 * file-request fix; SES double-send in PR #83 proved delivery).
 */
const sendConsolidatedShareEmail = async ({
  recipientEmail, fileRows, sender, moduledata, message, expires_on,
}) => {
  if (!sender?.mail_box_detail?.email_address || !sender?.mail_box_detail?.id) {
    return { email: recipientEmail, sent: false, reason: 'sender_has_no_mailbox' };
  }
  if (!moduledata) {
    return { email: recipientEmail, sent: false, reason: 'moduledata_required' };
  }
  if (!Array.isArray(fileRows) || fileRows.length === 0) {
    return { email: recipientEmail, sent: false, reason: 'no_files_to_send' };
  }

  // Non-fatal: a folder-listing hiccup shouldn't block the share email —
  // imap-send still delivers, worst case the copy isn't filed in the folder.
  try {
    await ensureDistributedFolder(moduledata);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[drive-share] ensure Distributed Mails folder failed: ${err.message || err}`);
  }

  const senderLabel = sender?.full_name || sender?.email || 'A Zillit user';
  const payload = {
    from: `${sender.mail_box_detail.name || sender.full_name || ''} <${sender.mail_box_detail.email_address}>`.trim(),
    to: [{ email_address: recipientEmail }],
    cc: [],
    bcc: [],
    subject: `${senderLabel} shared ${fileRows.length} file${fileRows.length === 1 ? '' : 's'} with you`,
    body: buildConsolidatedEmailHtml({
      fileRows, sender, message, expires_on,
    }),
    storage_folder: DISTRIBUTED_FOLDER,
  };

  const bodyhash = new EncryptDecryptUtil().hashWithSHA256(
    JSON.stringify({ payload, moduledata }),
  );

  try {
    await axios.request({
      method: 'post',
      maxBodyLength: Infinity,
      url: `${getUrls('CNC_BASE_URL')}/v2/imap-send`,
      headers: { moduledata, bodyhash },
      data: payload,
    });
    return { email: recipientEmail, sent: true };
  } catch (err) {
    const apiError = err?.response?.data?.message || err?.message || String(err);
    // Same emailapi false-negative we hit in PR #94: a 400 `email_sent_failed`
    // is returned AFTER MailSlurp has already accepted the message. Treat
    // ONLY this specific response as a successful send.
    if (apiError === 'email_sent_failed') {
      return { email: recipientEmail, sent: true };
    }
    return { email: recipientEmail, sent: false, reason: apiError };
  }
};

/**
 * Bulk create share links across many files in one call, then send ONE
 * consolidated email per recipient containing links to all the files
 * that succeeded (replaces the FE having to fire N single-file creates
 * + receive N emails per recipient — the Stone Soup PDF workflow,
 * native).
 *
 * Per-recipient tokens are still generated per-file so forensic
 * watermarking stays attributable. Per-file failures (file missing,
 * no edit permission, etc.) don't abort the batch — they're recorded
 * in `errors` and excluded from the email.
 */
const bulkCreateShareLinks = async ({ user, project, body, moduledata }) => {
  const {
    file_ids = [],
    permission = 'view',
    expires_in_ms,
    max_views = 0,
    message = '',
    recipients = [],
  } = body || {};

  if (!Array.isArray(file_ids) || file_ids.length === 0) {
    throw new BadRequest('file_ids_required');
  }
  if (file_ids.length > 100) {
    throw new BadRequest('max_100_files_per_bulk_operation');
  }
  if (!Array.isArray(recipients)) {
    throw new BadRequest('recipients_required');
  }
  if (recipients.length > 50) {
    throw new BadRequest('max_50_recipients_per_bulk_share_link');
  }

  const now = Date.now();
  const ttl = typeof expires_in_ms === 'number'
    ? expires_in_ms
    : 7 * 24 * 60 * 60 * 1000;
  const expires_on = ttl === 0 ? 0 : now + ttl;

  // Batched file lookup — one round-trip for all ids.
  const files = await DriveFileRepository.getFiles({
    filters: {
      _id: { $in: file_ids },
      project_id: project._id,
      deleted_on: 0,
    },
  });
  const fileById = new Map(files.map((f) => [String(f._id), f]));

  const created = [];
  const errors = [];

  // Per-file: assert edit access, create link record with per-recipient
  // tokens. Sequential here (not Promise.all) so a token-generation
  // collision under load doesn't race — N≤100 files, each is a small
  // create.
  for (const fileId of file_ids) {
    try {
      const file = fileById.get(String(fileId));
      if (!file) {
        errors.push({ file_id: fileId, error: 'file_not_found' });
        continue;
      }
      await DriveFileAccessService.assertFileAccess({
        user, project, file, permission: 'edit',
      });

      const linkRecipients = recipients.map((r) => ({
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
          permission: ['view', 'view_download'].includes(permission) ? permission : 'view',
          created_by: user._id,
          created_on: now,
          updated_on: now,
          expires_on,
          max_views: max_views || 0,
          view_count: 0,
          revoked: false,
          recipients: linkRecipients,
          message: message || '',
        },
      });

      created.push({
        file_id: toIdString(file._id),
        file_name: file.file_name,
        link_id: toIdString(link._id),
        token: link.token,
        url: `${PUBLIC_BASE_URL}/share/${link.token}`,
        permission: link.permission,
        expires_on: link.expires_on,
        recipients: link.recipients.map((r) => ({
          email: r.email,
          recipient_token: r.recipient_token,
          url: `${PUBLIC_BASE_URL}/share/${link.token}?r=${r.recipient_token}`,
        })),
      });
    } catch (err) {
      errors.push({ file_id: fileId, error: err?.message || 'create_failed' });
    }
  }

  // Send ONE consolidated email per recipient containing all the files
  // that succeeded for them. Per-recipient URL uses that recipient's
  // per-file token for watermark attribution.
  const email_results = [];
  if (recipients.length > 0 && created.length > 0) {
    const rowsByEmail = new Map();
    for (const linkInfo of created) {
      for (const r of linkInfo.recipients) {
        if (!rowsByEmail.has(r.email)) rowsByEmail.set(r.email, []);
        rowsByEmail.get(r.email).push({
          file_id: linkInfo.file_id,
          file_name: linkInfo.file_name,
          permission: linkInfo.permission,
          url: r.url,
        });
      }
    }

    // Sequential to avoid hammering emailapi with N concurrent sends
    // when the recipient list is large (50 cap). Per-recipient failures
    // are recorded, not thrown.
    for (const [email, fileRows] of rowsByEmail.entries()) {
      // eslint-disable-next-line no-await-in-loop
      const result = await sendConsolidatedShareEmail({
        recipientEmail: email,
        fileRows,
        sender: user,
        moduledata,
        message,
        expires_on,
      });
      email_results.push(result);
      // eslint-disable-next-line no-console
      console.info('[bulk_share_link_email_result]:', result);
    }
  }

  return {
    created_count: created.length,
    failed_count: errors.length,
    files: created,
    errors,
    email_results,
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

  // Narrow CSP frame-ancestors + drop X-Frame-Options for this endpoint.
  //
  // Helmet sets an app-wide `Content-Security-Policy: ...frame-ancestors 'self'`
  // and `X-Frame-Options: SAMEORIGIN`. PDFs are rendered via <iframe> in
  // the public viewer at https://*.zillit.com (and localhost during dev),
  // so the 'self' restriction blocks the iframe load cross-origin —
  // Chrome reports `(blocked:origin)` in the Network panel.
  //
  // We could strip the headers entirely (token validation is the real
  // gate, and frame-ancestors on a binary file stream protects against
  // nothing meaningful — any site that can iframe the URL must already
  // hold the share token, and could just as easily <img>/<video>/<curl>
  // the same URL). But "more locked is better" — allowlist Zillit
  // domains (the only legitimate viewer hosts) instead.
  //
  // `frame-ancestors` here covers: dev.zillit.com, qa.zillit.com,
  // web.zillit.com, and any *.zillit.com subdomain plus localhost for
  // dev. Anywhere else still gets blocked at the embed layer.
  //
  // X-Frame-Options is removed because legacy spec; CSP frame-ancestors
  // supersedes it and Chrome can be inconsistent when both are present.
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://*.zillit.com http://localhost:* http://127.0.0.1:*;",
  );
  res.removeHeader('X-Frame-Options');

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
  bulkCreateShareLinks,
  listShareLinks,
  revokeShareLink,
  getViewerData,
  getStreamUrl,
  streamContent,
  getOfficeViewerConfig,
  recordView,
};
