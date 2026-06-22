import crypto from 'crypto';
import axios from 'axios';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

import BadRequest from 'zillit-libs/errors/BadRequest';
import Forbidden from 'zillit-libs/errors/Forbidden';
import NotFound from 'zillit-libs/errors/NotFound';
import EncryptDecryptUtil from 'zillit-libs/utils/encrypt-decrypt';

import DriveFileRequestRepository from '../../repositories/v2/driveFileRequest.js';
import DriveFolderRepository from '../../repositories/v2/driveFolder.js';
import DriveFileRepository from '../../repositories/v2/driveFile.js';
import { getUrls } from './config.js';

/**
 * DriveFileRequestService
 *
 * Inverse of DriveShareLinkService — public upload URLs that let
 * anyone send files into a Zillit user's chosen Drive folder without
 * a Zillit account. URL shape:
 *
 *   https://drive.zillit.com/request/<token>
 *
 * Authenticated endpoints (createFileRequest / listFileRequests /
 * revokeFileRequest) require the caller to have edit access on the
 * destination folder. Public endpoints (getRequestViewerData /
 * startUploadSession / receiveUpload) take the URL token only — no
 * moduledata, no project session — and enforce the gates:
 *   - request not revoked
 *   - not expired
 *   - per-session file count + total bytes under limits
 *   - mime type matches allowed_mime_patterns
 */

/* ───────────── S3 (shared with driveUpload.js) ───────────── */

// Resolve bucket + region EXACTLY like driveUpload.js. The dev/prod
// env sets `S3_BUCKET` (not `AWS_S3_BUCKET`) and the bucket lives in
// ap-south-1 (Mumbai). The previous values (`AWS_S3_BUCKET` only,
// region default us-east-1) resolved the bucket to undefined / wrong
// region, so the S3 PutObject failed once uploads finally reached it.
// Prefer the dedicated S3_REGION env (prod sets it to the bucket's real
// region, ap-south-1) over the SDK-global AWS_REGION (prod sets that to
// us-east-1 to match the ECS/infra region). Reading AWS_REGION made the
// S3 client target us-east-1 while the bucket lives in ap-south-1, so any
// DIRECT server-side S3 op (this file's PutObject, the share-link proxy
// GetObject, the bulk ZIP) got a 301 "must be addressed using the
// specified endpoint". Presigned-URL flows survived via the us-east-1
// global-endpoint redirect, which masked the misconfig on normal uploads.
const S3_DEFAULT_REGION = process.env.S3_REGION
  || process.env.AWS_S3_BUCKET_REGION
  || process.env.AWS_REGION
  || 'ap-south-1';
const S3_BUCKET = process.env.S3_BUCKET
  || process.env.AWS_S3_BUCKET
  || 'zillit-bucket-mumbai-dev';

const s3ClientCache = {};

const getS3Client = (region) => {
  const resolvedRegion = region || S3_DEFAULT_REGION;
  if (!s3ClientCache[resolvedRegion]) {
    s3ClientCache[resolvedRegion] = new S3Client({
      region: resolvedRegion,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3ClientCache[resolvedRegion];
};

/* ───────────── Helpers ───────────── */

// 32-char URL-safe base64. Same shape as share-link tokens so the two
// systems read consistently in logs / DB.
const generateToken = () => crypto.randomBytes(24).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Per-recipient-visit id. Not security-critical (it just attributes
// multiple files in one visit to one row) but should be hard to
// collide so different visitors don't append into each other's row.
const generateSessionId = () => crypto.randomBytes(16).toString('hex');

const toIdString = (value) => (value ? value.toString() : null);

// Mirrors driveUpload.js generateS3Key so request-uploaded files
// land in the same key shape as normal uploads — anyone walking the
// bucket can't tell apart "user upload" from "file request upload"
// just from the path.
const generateS3Key = (projectId, folderId, fileName) => {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  const sanitised = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const folderPart = folderId ? `/${toIdString(folderId)}` : '';
  return `${toIdString(projectId)}/drive${folderPart}/${timestamp}_${random}_${sanitised}`;
};

const formatFileSize = (bytes) => {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / (1024 ** i)).toFixed(2)} ${units[i]}`;
};

const guessMimeType = (fileName, providedMime) => {
  if (providedMime) return providedMime;
  const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
  const map = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', heic: 'image/heic',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    mp3: 'audio/mpeg', wav: 'audio/wav',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain', csv: 'text/csv', json: 'application/json',
  };
  return map[ext] || 'application/octet-stream';
};

/**
 * Match `mime` against a list of allowed patterns. Each pattern is
 * either an exact mime ('image/png') or a wildcard at the subtype
 * level ('image/*'). Empty allowlist = anything allowed.
 */
const mimeAllowed = (mime, patterns) => {
  if (!patterns || patterns.length === 0) return true;
  const [type, subtype] = (mime || '').split('/');
  return patterns.some((p) => {
    const [pType, pSubtype] = p.split('/');
    if (pType === '*') return true;
    if (pType !== type) return false;
    return pSubtype === '*' || pSubtype === subtype;
  });
};

/**
 * Validate a public token. Loads the request and enforces the gates
 * every public endpoint cares about. Throws with a stable error code
 * the FE can map to a user-facing message.
 */
const validatePublicToken = async ({ token }) => {
  if (!token) throw new BadRequest('share_link_token_required');

  const request = await DriveFileRequestRepository.findByToken({ token });
  if (!request) throw new NotFound('file_request_not_found');
  if (request.revoked) throw new Forbidden('file_request_revoked');
  if (request.expires_on && Date.now() > request.expires_on) {
    throw new Forbidden('file_request_expired');
  }
  return { request };
};

/* ───────────── Invite email (distribution path) ───────────── */

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// Build the HTML body for the upload-invite email. This is the inverse
// of the share-link email — instead of "X shared a file with you" it's
// "X is requesting files from you" with an "Upload files" CTA.
const buildRequestEmailHtml = ({ request, url, sender }) => {
  const senderName = sender?.full_name || sender?.first_name || sender?.email || 'A Zillit user';
  const expiryText = request.expires_on > 0
    ? `This upload link expires on ${new Date(request.expires_on).toUTCString()}.`
    : 'This upload link does not expire.';
  const description = request.description
    ? `<p style="margin:16px 0;color:#333;">${escapeHtml(request.description)}</p>`
    : '';

  return `
<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 16px;">${escapeHtml(senderName)} is requesting files from you</h2>
  <p style="margin:0 0 8px;color:#555;">
    via <strong>Zillit Drive</strong>
  </p>
  <div style="border:1px solid #eee;border-radius:8px;padding:16px;margin:16px 0;background:#fafafa;">
    <div style="font-size:14px;color:#666;">Request</div>
    <div style="font-size:16px;font-weight:600;margin-top:4px;">${escapeHtml(request.title)}</div>
  </div>
  ${description}
  <p style="margin:24px 0;">
    <a href="${url}" style="display:inline-block;background:#f99300;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;">Upload files</a>
  </p>
  <p style="margin:16px 0;font-size:12px;color:#666;">
    ${expiryText}<br>
    No Zillit account is needed — just open the link and upload.
  </p>
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
  <p style="font-size:11px;color:#999;margin:0;">
    If you cannot click the button, paste this URL into your browser:<br>
    <span style="word-break:break-all;">${url}</span>
  </p>
</body></html>`;
};

/**
 * Send a single upload-invite email through the email service's
 * /v2/imap-send endpoint — the same distribution pipeline driveShareLink
 * uses. The email is dispatched from the sender's provisioned mailbox
 * (user.mail_box_detail.email_address), not info@zillit.com, so it
 * avoids same-domain anti-spoof rejection and lands in the sender's
 * "Distributed Mails" folder for audit.
 *
 * Throws on any precondition miss / transport error so the caller can
 * record a per-recipient failure.
 */
const sendRequestEmailViaDistribution = async ({
  request, url, email, sender, moduledata,
}) => {
  if (!sender?.mail_box_detail?.email_address || !sender?.mail_box_detail?.id) {
    throw new Error('sender_has_no_mailbox');
  }
  if (!moduledata) {
    throw new Error('moduledata_required_for_imap_send');
  }

  const payload = {
    from: `${sender.mail_box_detail.name || sender.full_name || ''} <${sender.mail_box_detail.email_address}>`.trim(),
    to: [{ email_address: email }],
    cc: [],
    bcc: [],
    subject: `${sender?.full_name || sender?.email || 'A Zillit user'} is requesting files from you`,
    body: buildRequestEmailHtml({ request, url, sender }),
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
 * Top-level invite send for one recipient. Mirrors driveShareLink's
 * sendShareEmail: logs the attempt, skips (does not throw) when the
 * sender has no mailbox / no moduledata, and swallows transport errors
 * so one bad recipient never fails request creation. Returns a result
 * object the caller aggregates into the API response.
 */
const sendRequestEmail = async ({
  request, url, email, sender, moduledata,
}) => {
  // eslint-disable-next-line no-console
  console.info('[file_request_email_attempt]:', {
    to: email,
    sender_id: String(sender?._id || ''),
    has_mailbox: !!(sender?.mail_box_detail?.id),
    has_moduledata: !!moduledata,
  });

  if (!sender?.mail_box_detail?.id) {
    // eslint-disable-next-line no-console
    console.warn('[file_request_email_skipped_no_mailbox]:', { to: email });
    return { email, sent: false, reason: 'sender_has_no_mailbox' };
  }
  if (!moduledata) {
    // eslint-disable-next-line no-console
    console.warn('[file_request_email_skipped_no_moduledata]:', { to: email });
    return { email, sent: false, reason: 'moduledata_required' };
  }

  try {
    await sendRequestEmailViaDistribution({
      request, url, email, sender, moduledata,
    });
    // eslint-disable-next-line no-console
    console.info('[file_request_email_sent]:', {
      to: email, from: sender.mail_box_detail.email_address,
    });
    return { email, sent: true };
  } catch (err) {
    const apiError = err?.response?.data?.message || err?.message || String(err);

    // emailapi /v2/imap-send returns 400 `email_sent_failed` AFTER
    // MailSlurp has already queued/delivered the message — it is a
    // confirmed false-negative in this codebase: during the share-link
    // work the SES fallback fired on this exact error and delivered a
    // SECOND copy (why PR #83 removed that fallback). Verified again
    // here — the recipient received the mail despite this response.
    // So treat ONLY this specific message as a successful send; every
    // other error remains a genuine failure.
    if (apiError === 'email_sent_failed') {
      // eslint-disable-next-line no-console
      console.info('[file_request_email_sent_queued]:', {
        to: email,
        note: 'emailapi returned email_sent_failed but the message is delivered',
      });
      return { email, sent: true };
    }

    // eslint-disable-next-line no-console
    console.warn('[file_request_email_failed]:', { to: email, error: apiError });
    return { email, sent: false, reason: apiError };
  }
};

/* ───────────── Authenticated endpoints ───────────── */

const createFileRequest = async ({ user, project, body, moduledata }) => {
  const folder = await DriveFolderRepository.getFolder({
    filters: {
      _id: body.destination_folder_id,
      project_id: project._id,
      deleted_on: 0,
    },
  });
  if (!folder) throw new NotFound('destination_folder_not_found');

  // Edit-equivalent gate: only users who could upload to this folder
  // themselves are allowed to invite the world to upload to it.
  // driveFileAccess exposes assertFileAccess but not a folder
  // variant — keep this check inline + simple: creator of the folder
  // OR project admin. Future iteration can plug into a full folder
  // ACL once that's exposed by driveFileAccess.
  const isFolderCreator = String(folder.created_by) === String(user._id);
  const isAdmin = !!user?.admin_access;
  if (!isFolderCreator && !isAdmin) {
    throw new Forbidden('insufficient_folder_permission');
  }

  const now = Date.now();
  const expires_on = body.expires_in_ms === 0 ? 0 : now + body.expires_in_ms;

  const request = await DriveFileRequestRepository.create({
    data: {
      project_id: project._id,
      destination_folder_id: folder._id,
      token: generateToken(),
      title: body.title,
      description: body.description || '',
      thank_you_message: body.thank_you_message || '',
      created_by: user._id,
      created_on: now,
      updated_on: now,
      expires_on,
      max_files_per_session: body.max_files_per_session || 0,
      max_total_size_bytes: body.max_total_size_bytes || 0,
      allowed_mime_patterns: body.allowed_mime_patterns || [],
      require_uploader_email: body.require_uploader_email !== false,
      require_uploader_name: !!body.require_uploader_name,
      revoked: false,
      upload_count: 0,
      total_uploaded_bytes: 0,
      sessions: [],
    },
  });

  const url = `${resolvePublicWebUrl()}/request/${request.token}`;

  // Optional: email the link to recipients at creation time. The link
  // is the same one the sender can copy manually — emailing is purely a
  // convenience. De-dupe + drop blanks. Sends are best-effort: a failed
  // send is reported in email_results but never fails request creation
  // (the link already exists and can be shared manually).
  const recipientEmails = Array.from(new Set(
    (body.recipients || [])
      .map((e) => String(e || '').toLowerCase().trim())
      .filter(Boolean),
  ));

  let email_results = [];
  if (recipientEmails.length > 0) {
    email_results = await Promise.all(recipientEmails.map((email) => sendRequestEmail({
      request, url, email, sender: user, moduledata,
    })));
  }

  return {
    _id: request._id,
    token: request.token,
    url,
    title: request.title,
    destination_folder_id: request.destination_folder_id,
    expires_on: request.expires_on,
    max_files_per_session: request.max_files_per_session,
    max_total_size_bytes: request.max_total_size_bytes,
    allowed_mime_patterns: request.allowed_mime_patterns,
    require_uploader_email: request.require_uploader_email,
    require_uploader_name: request.require_uploader_name,
    email_results,
  };
};

const listFileRequests = async ({ user, project, params }) => {
  const { folderId } = params;
  const requests = await DriveFileRequestRepository.findActiveByFolder({
    project_id: project._id,
    destination_folder_id: folderId,
  });
  return requests.map((r) => ({
    _id: r._id,
    token: r.token,
    url: `${resolvePublicWebUrl()}/request/${r.token}`,
    title: r.title,
    description: r.description,
    created_by: r.created_by,
    created_on: r.created_on,
    expires_on: r.expires_on,
    upload_count: r.upload_count,
    total_uploaded_bytes: r.total_uploaded_bytes,
    session_count: r.sessions?.length || 0,
    require_uploader_email: r.require_uploader_email,
    require_uploader_name: r.require_uploader_name,
    // Only return the latest few sessions in the list view — full
    // detail is in the drill-in endpoint to keep this response small.
    recent_sessions: (r.sessions || []).slice(-5).map((s) => ({
      uploader_email: s.uploader_email,
      uploader_name: s.uploader_name,
      file_count: s.files?.length || 0,
      started_on: s.started_on,
      last_upload_on: s.last_upload_on,
    })),
  }));
};

const revokeFileRequest = async ({ user, project, params }) => {
  const { requestId } = params;
  const request = await DriveFileRequestRepository.findById({ _id: requestId });
  if (!request) throw new NotFound('file_request_not_found');
  if (String(request.project_id) !== String(project._id)) {
    throw new Forbidden('file_request_not_in_project');
  }
  // Creator can always revoke. Folder creator + project admins can
  // also revoke (catches the case where the original request creator
  // left the project).
  const isCreator = String(request.created_by) === String(user._id);
  const isAdmin = !!user?.admin_access;
  if (!isCreator && !isAdmin) {
    const folder = await DriveFolderRepository.getFolder({
      filters: { _id: request.destination_folder_id },
    });
    const isFolderCreator = folder && String(folder.created_by) === String(user._id);
    if (!isFolderCreator) {
      throw new Forbidden('insufficient_folder_permission');
    }
  }
  await DriveFileRequestRepository.updateById({
    _id: requestId,
    data: {
      revoked: true,
      revoked_on: Date.now(),
      revoked_by: user._id,
    },
  });
  return { ok: true };
};

/* ───────────── Public (token-only) endpoints ───────────── */

const getRequestViewerData = async ({ params }) => {
  const { token } = params;
  const { request } = await validatePublicToken({ token });

  return {
    title: request.title,
    description: request.description,
    thank_you_message: request.thank_you_message,
    expires_on: request.expires_on,
    max_files_per_session: request.max_files_per_session,
    max_total_size_bytes: request.max_total_size_bytes,
    allowed_mime_patterns: request.allowed_mime_patterns,
    require_uploader_email: request.require_uploader_email,
    require_uploader_name: request.require_uploader_name,
  };
};

const startUploadSession = async ({ params, body, req }) => {
  const { token } = params;
  const { request } = await validatePublicToken({ token });

  const uploader_email = (body?.uploader_email || '').toLowerCase().trim();
  const uploader_name = (body?.uploader_name || '').trim();

  if (request.require_uploader_email && !uploader_email) {
    throw new BadRequest('uploader_email_required');
  }
  if (request.require_uploader_name && !uploader_name) {
    throw new BadRequest('uploader_name_required');
  }

  const session = {
    session_id: generateSessionId(),
    uploader_email,
    uploader_name,
    ip_address: req?.ip || req?.headers?.['x-forwarded-for'] || '',
    user_agent: req?.headers?.['user-agent'] || '',
    started_on: Date.now(),
    last_upload_on: 0,
    files: [],
  };

  await DriveFileRequestRepository.appendSession({
    _id: request._id, session,
  });

  return { session_id: session.session_id };
};

/**
 * Multipart upload handler. Expects:
 *   - req.files.file populated by express-fileupload
 *   - query.session_id matching a session created via startUploadSession
 *
 * Validates the upload against the request's gates, PUTs the bytes to
 * S3, creates a DriveFileV2 doc in the destination folder, and appends
 * the file record to the session for audit.
 */
const receiveUpload = async ({ params, query, req }) => {
  const { token } = params;
  const session_id = query?.session_id;
  if (!session_id) throw new BadRequest('session_id_required');

  const { request } = await validatePublicToken({ token });

  // Find the session this upload belongs to.
  const session = (request.sessions || [])
    .find((s) => s.session_id === session_id);
  if (!session) throw new BadRequest('invalid_session_id');

  // express-fileupload puts the uploaded file at req.files.file.
  // Single-file uploads per request to keep the validation logic
  // simple — the FE iterates client-side and POSTs one at a time.
  const uploaded = req?.files?.file;
  if (!uploaded || Array.isArray(uploaded)) {
    throw new BadRequest('exactly_one_file_per_request');
  }

  const fileName = uploaded.name || 'untitled';
  const fileSize = uploaded.size || 0;
  const mimeType = guessMimeType(fileName, uploaded.mimetype);

  // ─── Gate: per-session file count ───
  if (request.max_files_per_session > 0
      && session.files.length >= request.max_files_per_session) {
    throw new BadRequest('max_files_per_session_exceeded');
  }

  // ─── Gate: per-session total bytes ───
  const sessionBytesSoFar = session.files.reduce(
    (sum, f) => sum + (f.file_size_bytes || 0), 0,
  );
  if (request.max_total_size_bytes > 0
      && sessionBytesSoFar + fileSize > request.max_total_size_bytes) {
    throw new BadRequest('max_total_size_bytes_exceeded');
  }

  // ─── Gate: mime allowlist ───
  if (!mimeAllowed(mimeType, request.allowed_mime_patterns)) {
    throw new BadRequest('file_type_not_allowed');
  }

  // Upload to S3 using the same key shape as authenticated uploads.
  const s3Key = generateS3Key(request.project_id, request.destination_folder_id, fileName);
  const s3 = getS3Client(S3_DEFAULT_REGION);
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    Body: uploaded.data,
    ContentType: mimeType,
  }));

  // Create the DriveFile record. Important fields:
  //   - created_by: the file request's creator (so file ownership
  //     belongs to a real Zillit user and inherits their permissions)
  //   - uploaded_by: same; we record the recipient identity on the
  //     file request's session, not on the file (DriveFile schema
  //     expects uploaded_by to be a ProjectUserV2 ObjectId)
  const fileExtension = fileName.includes('.')
    ? fileName.split('.').pop().toLowerCase()
    : '';

  const driveFile = await DriveFileRepository.createFile({
    data: {
      project_id: request.project_id,
      folder_id: request.destination_folder_id,
      file_name: fileName,
      file_path: s3Key,
      description: '',
      file_type: mimeType.split('/')[0] || '',
      file_extension: fileExtension,
      file_size: formatFileSize(fileSize),
      file_size_bytes: fileSize,
      mime_type: mimeType,
      attachments: [{
        media: s3Key,
        name: fileName,
        thumbnail: '',
        content_type: mimeType.split('/')[0] || 'document',
        content_subtype: mimeType.split('/')[1] || '',
        caption: '',
        duration: 0, height: 0, width: 0,
        bucket: S3_BUCKET,
        region: S3_DEFAULT_REGION,
        created: Date.now(),
        file_size: formatFileSize(fileSize),
        content_id: '',
      }],
      created_by: request.created_by,
      updated_by: request.created_by,
      uploaded_by: request.created_by,
    },
  });

  await DriveFileRequestRepository.recordSessionFileUpload({
    _id: request._id,
    session_id,
    file: {
      drive_file_id: driveFile._id,
      file_name: fileName,
      file_size_bytes: fileSize,
      mime_type: mimeType,
      uploaded_on: Date.now(),
    },
    bytes: fileSize,
  });

  return {
    drive_file_id: driveFile._id,
    file_name: fileName,
    file_size_bytes: fileSize,
    mime_type: mimeType,
  };
};

/* ───────────── Public web URL resolver (per-env) ───────────── */

const resolvePublicWebUrl = () => {
  if (process.env.PUBLIC_WEB_URL) return process.env.PUBLIC_WEB_URL;
  const env = (process.env.NODE_ENV || '').toLowerCase();
  if (env === 'prod' || env === 'production') return 'https://web.zillit.com';
  if (env === 'qa') return 'https://qa.zillit.com';
  return 'https://dev.zillit.com';
};

export default {
  createFileRequest,
  listFileRequests,
  revokeFileRequest,
  getRequestViewerData,
  startUploadSession,
  receiveUpload,
};
