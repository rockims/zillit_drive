import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import axios from 'axios';
import crypto from 'crypto';
import BadRequest from 'zillit-libs/errors/BadRequest';
import Forbidden from 'zillit-libs/errors/Forbidden';

import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveAccessService from './driveAccess.js';
import DriveFileAccessService from './driveFileAccess.js';
import DriveActivityService from './driveActivity.js';
import DriveVersionService from './driveVersion.js';
import socketClient from '../../config/socketClient.js';
import jwt from 'jsonwebtoken';
import { signOnlyOfficeToken, verifyOnlyOfficeToken } from '../../utils/onlyofficeJwt.js';

/* ───────────── S3 Config (same pattern as driveFile.js) ───────────── */

const S3_DEFAULT_REGION = process.env.AWS_REGION || 'ap-south-1';
const S3_BUCKET = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || 'zillit-drive';
const STREAM_URL_EXPIRY_SECONDS = 3600;

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
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return s3ClientCache[resolvedRegion];
};

/* ───────────── OnlyOffice Config ───────────── */

const ONLYOFFICE_CALLBACK_BASE_URL =
  process.env.ONLYOFFICE_CALLBACK_BASE_URL || 'http://localhost:8105/api';

const ONLYOFFICE_SERVER_URL =
  process.env.ONLYOFFICE_SERVER_URL || 'http://localhost:8080';
const ONLYOFFICE_PUBLIC_URL =
  process.env.ONLYOFFICE_PUBLIC_URL || ONLYOFFICE_SERVER_URL;

const EDITOR_PAGE_JWT_SECRET =
  process.env.ONLYOFFICE_JWT_SECRET || 'fallback';

// Supported file types for OnlyOffice editing
const EDITABLE_EXTENSIONS = ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'odt', 'ods', 'odp', 'csv', 'txt'];

const getDocumentType = (ext) => {
  const spreadsheet = ['xlsx', 'xls', 'ods', 'csv'];
  const presentation = ['pptx', 'ppt', 'odp'];
  if (spreadsheet.includes(ext)) return 'cell';
  if (presentation.includes(ext)) return 'slide';
  return 'word'; // default for doc/docx/odt/txt etc.
};

/* ───────────── Get Editor Config ───────────── */

/**
 * Generates an OnlyOffice editor configuration for a given file.
 * The browser calls this to get the config needed to open the editor.
 *
 * Flow:
 *   1. Load file and check edit permissions
 *   2. Generate a presigned S3 URL (OnlyOffice fetches the file from this URL)
 *   3. Build the OnlyOffice config with document info, user info, callback URL
 *   4. Sign the config as a JWT token
 *   5. Return config + token
 */
const getEditorConfig = async ({ user, project, params, query = {} }) => {
  const { fileId } = params;
  const forceViewOnly = query.mode === 'view';

  // 1. Load the file
  const file = await DriveFileRepository.getFile({
    filters: { _id: fileId, project_id: project._id, deleted_on: 0 },
  });

  if (!file) {
    throw new BadRequest('file_not_found');
  }

  // 2. Resolve the user's actual permissions on this file
  const permissions = await DriveFileAccessService.resolveFilePermission({
    user, project, file,
  });

  // Must have at least view permission to open the file at all
  if (!permissions || !permissions.can_view) {
    throw new Forbidden('insufficient_permissions');
  }

  // If mode=view is requested (e.g. preview/eye button), force view-only regardless of permissions
  const canEdit = forceViewOnly ? false : !!permissions.can_edit;

  // 3. Validate file type is supported by OnlyOffice
  const ext = (file.file_extension || '').toLowerCase().replace(/^\./, '');
  if (!EDITABLE_EXTENSIONS.includes(ext)) {
    throw new BadRequest('file_type_not_editable');
  }

  // 4. Build a proxy download URL for OnlyOffice to fetch the document.
  //    We proxy through our backend instead of giving OnlyOffice a direct S3 presigned URL,
  //    because OnlyOffice's internal HTTP client (axios + follow-redirects) re-encodes
  //    URL query parameters, which invalidates S3 presigned URL signatures (HTTP 400).
  const s3Key = file.file_path
    || file.attachments?.[0]?.media
    || file.attachments?.[0]?.file_path;

  if (!s3Key) {
    throw new BadRequest('file_has_no_storage_path');
  }

  // 5. Build the OnlyOffice config
  // Use a stable key based on file ID + last modified timestamp.
  // This ensures concurrent users get the SAME key (co-editing works),
  // but the key changes after each save (forces OnlyOffice to re-download).
  const documentKey = `${file._id}_${file.updated_on || file.created_on}`;

  // Generate a short-lived HMAC token for the proxy download endpoint
  const downloadToken = crypto
    .createHmac('sha256', process.env.ONLYOFFICE_JWT_SECRET || 'fallback')
    .update(`${file._id}:${documentKey}`)
    .digest('hex');

  // OnlyOffice fetches the document from this URL (our backend proxies to S3)
  const documentUrl = `${ONLYOFFICE_CALLBACK_BASE_URL}/v2/drive/editor/${file._id}/download`
    + `?key=${documentKey}&token=${downloadToken}`;

  // Only set callback URL if user can edit — prevents view-only users from saving
  const callbackUrl = canEdit
    ? `${ONLYOFFICE_CALLBACK_BASE_URL}/v2/drive/editor/callback`
      + `?fileId=${file._id}&projectId=${project._id}&userId=${user._id}`
    : null;

  const config = {
    document: {
      fileType: ext,
      key: documentKey,
      title: file.file_name,
      url: documentUrl,
      // OnlyOffice permissions object — restricts UI actions based on user's actual permissions
      permissions: {
        edit: canEdit,
        comment: canEdit,
        download: !!permissions.can_download,
        print: !!permissions.can_download,
        copy: !!permissions.can_view,
        review: canEdit,
        fillForms: canEdit,
        modifyFilter: canEdit,
        modifyContentControl: canEdit,
      },
    },
    documentType: getDocumentType(ext),
    editorConfig: {
      ...(callbackUrl ? { callbackUrl } : {}),
      user: {
        id: user._id.toString(),
        name: user.full_name || user.name || user.email || 'User',
      },
      // mode: 'view' makes OnlyOffice open in read-only mode (no editing toolbar)
      // mode: 'edit' opens with full editing capabilities
      mode: canEdit ? 'edit' : 'view',
      lang: 'en',
      customization: {
        autosave: canEdit,
        forcesave: canEdit,
        chat: false,
        comments: canEdit,
        compactHeader: true,
      },
    },
  };

  // 6. Sign the config as JWT
  const token = signOnlyOfficeToken(config);
  config.token = token;

  console.log(`[driveEditor] Generated config for user ${user._id} (mode: ${canEdit ? 'edit' : 'view'}, forceViewOnly: ${forceViewOnly}, query.mode: ${query.mode})`);

  return { ...config, _permissions: { canEdit, canView: true, canDownload: !!permissions.can_download } };
};

/* ───────────── Proxy Document Download for OnlyOffice ───────────── */

/**
 * Streams the file from S3 to OnlyOffice Document Server.
 * OnlyOffice calls this endpoint to fetch the document for editing.
 *
 * This proxy exists because OnlyOffice's internal HTTP client (axios + follow-redirects)
 * re-encodes URL query parameters, which breaks AWS S3 presigned URL signatures.
 * By proxying through our backend, OnlyOffice gets a simple HTTP URL with no encoding issues.
 *
 * Auth: HMAC token in query string (generated when editor config was created).
 */
const proxyDocumentDownload = async ({ params, query, res }) => {
  const { fileId } = params;
  const { key: documentKey, token: downloadToken } = query;

  if (!documentKey || !downloadToken) {
    throw new BadRequest('missing_download_token');
  }

  // Verify the HMAC token
  const expectedToken = crypto
    .createHmac('sha256', process.env.ONLYOFFICE_JWT_SECRET || 'fallback')
    .update(`${fileId}:${documentKey}`)
    .digest('hex');

  if (downloadToken !== expectedToken) {
    throw new BadRequest('invalid_download_token');
  }

  // Load the file from DB (no user/project auth — the HMAC token is the auth)
  const file = await DriveFileRepository.getFile({
    filters: { _id: fileId, deleted_on: 0 },
  });

  if (!file) {
    throw new BadRequest('file_not_found');
  }

  const s3Key = file.file_path
    || file.attachments?.[0]?.media
    || file.attachments?.[0]?.file_path;

  if (!s3Key) {
    throw new BadRequest('file_has_no_storage_path');
  }

  const attachment = file.attachments?.[0] || {};
  const bucket = attachment.bucket || S3_BUCKET;
  const region = attachment.region || S3_DEFAULT_REGION;
  const s3ForRegion = getS3Client(region);

  // Force Content-Type based on file extension to prevent OnlyOffice from
  // misinterpreting files (e.g. a .txt file containing HTML being rendered as HTML)
  const extMimeMap = {
    txt: 'text/plain',
    csv: 'text/csv',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    doc: 'application/msword',
    xls: 'application/vnd.ms-excel',
    ppt: 'application/vnd.ms-powerpoint',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    odp: 'application/vnd.oasis.opendocument.presentation',
  };
  const fileExt = (file.file_extension || file.file_name?.split('.').pop() || '').toLowerCase();
  const mimeType = extMimeMap[fileExt] || file.mime_type || attachment.content_type || 'application/octet-stream';

  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: s3Key,
  });

  const s3Response = await s3ForRegion.send(cmd);

  // Set headers and stream the S3 response body to the HTTP response
  res.setHeader('Content-Type', mimeType);
  if (s3Response.ContentLength) {
    res.setHeader('Content-Length', s3Response.ContentLength);
  }
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.file_name)}"`);

  // s3Response.Body is a Readable stream
  s3Response.Body.pipe(res);

  // Return null to signal the controller that we've already handled the response
  return null;
};

/* ───────────── Handle Editor Callback ───────────── */

/**
 * Handles the POST callback from OnlyOffice Document Server.
 * Called when a user saves/closes the document.
 *
 * OnlyOffice status codes:
 *   1 = document is being edited (no action needed)
 *   2 = document ready for saving (all users disconnected)
 *   4 = document closed with no changes
 *   6 = force save while editing
 *   7 = error while saving
 *
 * For status 2 and 6:
 *   1. Download the edited file from the URL OnlyOffice provides
 *   2. Create a version snapshot of the current file
 *   3. Upload the edited file to S3
 *   4. Update the DriveFile record
 *   5. Emit socket event + log activity
 */
const handleEditorCallback = async ({ body, query }) => {
  const { fileId, projectId, userId } = query;

  // Verify JWT from OnlyOffice — this is REQUIRED, not optional.
  // The JWT proves the callback came from our OnlyOffice server, not a malicious actor.
  if (!body.token) {
    console.error('[editor_callback] Missing JWT token in callback body');
    return { error: 1 };
  }

  try {
    verifyOnlyOfficeToken(body.token);
  } catch (err) {
    console.error('[editor_callback] JWT verification failed:', err.message);
    return { error: 1 };
  }

  const status = body.status;

  // Status 1 (editing) and 4 (no changes) — acknowledge without action
  if (status === 1 || status === 4) {
    return { error: 0 };
  }

  // Status 2 (ready to save) or 6 (force save) — download and store
  if (status !== 2 && status !== 6) {
    console.log(`[editor_callback] Unhandled status: ${status}`);
    return { error: 0 };
  }

  const downloadUrl = body.url;
  if (!downloadUrl) {
    console.error('[editor_callback] No download URL in callback body');
    return { error: 1 };
  }

  try {
    // 1. Load the current file from DB
    const file = await DriveFileRepository.getFile({
      filters: { _id: fileId, project_id: projectId, deleted_on: 0 },
    });

    if (!file) {
      console.error(`[editor_callback] File not found: ${fileId}`);
      return { error: 1 };
    }

    // 2. Verify the user actually has edit permission on this file.
    //    This prevents saves from sessions where a user somehow got a callback URL
    //    but doesn't have edit rights (defense in depth).
    if (userId) {
      try {
        const fileAccess = await DriveFileAccessService.resolveFilePermission({
          user: { _id: userId, admin_access: false },
          project: { _id: projectId },
          file,
        });
        if (!fileAccess || !fileAccess.can_edit) {
          console.error(`[editor_callback] User ${userId} lacks edit permission on file ${fileId}`);
          return { error: 1 };
        }
      } catch (permErr) {
        console.error(`[editor_callback] Permission check failed: ${permErr.message}`);
        return { error: 1 };
      }
    }

    // 2. Create a version snapshot of the current file before overwriting
    await DriveVersionService.createVersionSnapshot({
      projectId,
      file,
      userId: userId || file.updated_by || file.created_by,
    });

    // 3. Download the edited file from OnlyOffice
    const editedFileResponse = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 60000, // 60 seconds timeout
    });

    const fileBuffer = Buffer.from(editedFileResponse.data);

    // 4. Upload to S3 (use existing key — overwrite in place)
    const s3Key = file.file_path
      || file.attachments?.[0]?.media
      || file.attachments?.[0]?.file_path;

    const attachment = file.attachments?.[0] || {};
    const bucket = attachment.bucket || S3_BUCKET;
    const region = attachment.region || S3_DEFAULT_REGION;
    const s3ForRegion = getS3Client(region);

    const putCmd = new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: file.mime_type || 'application/octet-stream',
    });

    await s3ForRegion.send(putCmd);

    // 5. Update DriveFile record
    const updateData = {
      file_size_bytes: fileBuffer.length,
      file_size: formatFileSize(fileBuffer.length),
      updated_on: Date.now(),
      updated_by: userId || file.updated_by,
    };

    // Update attachments if present
    if (file.attachments?.length > 0) {
      updateData.attachments = [{
        ...file.attachments[0].toObject ? file.attachments[0].toObject() : file.attachments[0],
        file_size_bytes: fileBuffer.length,
      }];
    }

    await DriveFileRepository.updateFile({
      filters: { _id: fileId, project_id: projectId },
      data: updateData,
    });

    // 6. Emit socket event for real-time UI update
    socketClient('__admin_events__', {
      event: 'drive:file:updated',
      room: `${projectId}_room`,
      data: {
        project_id: projectId,
        file_id: fileId,
        action: 'editor_save',
      },
    });

    // 7. Log activity (fire-and-forget)
    DriveActivityService.log({
      projectId,
      userId: userId || file.updated_by,
      action: 'file_edited',
      itemId: fileId,
      itemType: 'file',
      itemName: file.file_name,
      details: { source: 'onlyoffice', status },
    });

    console.log(`[editor_callback] File saved: ${file.file_name} (${fileBuffer.length} bytes)`);

    return { error: 0 };
  } catch (err) {
    console.error('[editor_callback] Save failed:', err.message);
    return { error: 1 };
  }
};

/* ───────────── Generate Editor Page Token (for mobile WebView) ───────────── */

/**
 * Generates a short-lived JWT containing the full OnlyOffice editor config.
 * Called through the full middleware chain (authenticated), so user/project are verified.
 * The mobile app then loads the /page URL with this token in a WebView.
 */
const generateEditorPageToken = async ({ user, project, params }) => {
  // Reuse the existing getEditorConfig to build the full OnlyOffice config
  const config = await getEditorConfig({ user, project, params });

  // Add mobile-specific customizations to the config
  config.editorConfig.customization = {
    ...config.editorConfig.customization,
    mobile: true,
    toolbarNoTabs: true,
  };

  // Sign a short-lived JWT containing the full config
  const token = jwt.sign(
    { type: 'editor_page', config },
    EDITOR_PAGE_JWT_SECRET,
    { expiresIn: '5m' },
  );

  return { token };
};

/* ───────────── Serve Editor Page (for mobile WebView) ───────────── */

/**
 * Verifies the JWT from the query string, extracts the OnlyOffice config,
 * and returns a self-contained HTML page that loads the OnlyOffice editor.
 * No middleware needed — auth is via the signed JWT.
 */
const getEditorPage = async ({ params, query }) => {
  const { token } = query;

  if (!token) {
    throw new BadRequest('missing_editor_page_token');
  }

  let payload;
  try {
    payload = jwt.verify(token, EDITOR_PAGE_JWT_SECRET);
  } catch (err) {
    throw new BadRequest('invalid_or_expired_editor_page_token');
  }

  if (payload.type !== 'editor_page' || !payload.config) {
    throw new BadRequest('invalid_editor_page_token_payload');
  }

  const config = payload.config;
  const onlyofficeApiUrl = `${ONLYOFFICE_PUBLIC_URL}/web-apps/apps/api/documents/api.js`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${escapeHtml(config.document?.title || 'Editor')}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; }
    #editor { width: 100vw; height: 100vh; }
    #error { display: none; padding: 20px; color: #d32f2f; font-family: -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; margin-top: 40px; }
  </style>
</head>
<body>
  <div id="editor"></div>
  <div id="error"></div>
  <script src="${escapeHtml(onlyofficeApiUrl)}"></script>
  <script>
    (function() {
      try {
        var config = ${JSON.stringify(config)};
        if (typeof DocsAPI === 'undefined') {
          throw new Error('OnlyOffice API failed to load');
        }
        new DocsAPI.DocEditor('editor', config);
      } catch (e) {
        var errorDiv = document.getElementById('error');
        errorDiv.style.display = 'block';
        errorDiv.textContent = 'Failed to load editor: ' + e.message;
      }
    })();
  </script>
</body>
</html>`;

  return html;
};

/**
 * Escape HTML special characters to prevent XSS in generated HTML.
 */
const escapeHtml = (str) => {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

/* ───────────── Helper ───────────── */

const formatFileSize = (bytes) => {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
};

export default {
  getEditorConfig,
  proxyDocumentDownload,
  handleEditorCallback,
  generateEditorPageToken,
  getEditorPage,
};
