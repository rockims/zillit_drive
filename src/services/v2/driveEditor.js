import axios from 'axios';
import BadRequest from 'zillit-libs/errors/BadRequest';
import Forbidden from 'zillit-libs/errors/Forbidden';
import jwt from 'jsonwebtoken';

import DriveFileRepository from '../../repositories/v2/driveFile.js';
import DriveFileAccessService from './driveFileAccess.js';
import DriveWopiService from './driveWopi.js';
import { WOPI_SECRET } from '../../utils/editorJwt.js';

/* ───────────── Collabora Config ───────────── */

const COLLABORA_URL = process.env.COLLABORA_URL || 'http://localhost:9980';
const WOPI_BASE_URL = process.env.WOPI_BASE_URL || 'http://host.docker.internal:8105/api/v2/drive';

// Cache the Collabora editor URL (fetched from discovery endpoint)
let _collaboraEditorUrl = null;
let _collaboraEditorUrlExpiry = 0;

/**
 * Fetch the Collabora editor URL from the WOPI discovery endpoint.
 * Caches for 1 hour to avoid repeated requests.
 */
const getCollaboraEditorUrl = async () => {
  if (_collaboraEditorUrl && Date.now() < _collaboraEditorUrlExpiry) {
    return _collaboraEditorUrl;
  }
  try {
    const resp = await axios.get(`${COLLABORA_URL}/hosting/discovery`, { timeout: 5000 });
    const xml = resp.data;
    // Extract urlsrc from XML: urlsrc="http://localhost:9980/browser/HASH/cool.html?"
    const match = xml.match(/urlsrc="([^"]*cool\.html[^"]*)"/);
    if (match) {
      _collaboraEditorUrl = match[1].replace(/\?$/, '').replace(/^http:\/\//, 'https://'); // remove trailing ? and force https
      _collaboraEditorUrlExpiry = Date.now() + 60 * 60 * 1000; // 1 hour cache
      console.log(`[driveEditor] Collabora editor URL: ${_collaboraEditorUrl}`);
      return _collaboraEditorUrl;
    }
  } catch (err) {
    console.error('[driveEditor] Failed to fetch Collabora discovery:', err.message);
  }
  // Fallback
  return `${COLLABORA_URL}/browser/dist/cool.html`;
};

// Supported file types for Collabora editing
const EDITABLE_EXTENSIONS = [
  'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt',
  'odt', 'ods', 'odp', 'csv', 'txt', 'rtf',
];

/* ───────────── Get Editor Config ───────────── */

/**
 * Returns the Collabora editor configuration for a file.
 * The frontend uses this to build the Collabora iframe URL.
 */
const getEditorConfig = async ({ user, project, params, query = {} }) => {
  const { fileId } = params;
  const forceViewOnly = query.mode === 'view';

  const file = await DriveFileRepository.getFile({
    filters: { _id: fileId, project_id: project._id, deleted_on: 0 },
  });

  if (!file) throw new BadRequest('file_not_found');

  const permissions = await DriveFileAccessService.resolveFilePermission({ user, project, file });
  if (!permissions || !permissions.can_view) throw new Forbidden('insufficient_permissions');

  const canEdit = forceViewOnly ? false : !!permissions.can_edit;

  const ext = (file.file_extension || '').toLowerCase().replace(/^\./, '');
  if (!EDITABLE_EXTENSIONS.includes(ext)) throw new BadRequest('file_type_not_editable');

  // Generate WOPI access token
  const { token: accessToken, ttl: accessTokenTTL } = DriveWopiService.generateAccessToken({
    user, project, file,
    canEdit,
    canDownload: !!permissions.can_download,
  });

  // WOPI source URL — Collabora will call this to get file info and contents
  const wopiSrc = `${WOPI_BASE_URL}/wopi/files/${file._id}`;

  // Get the correct Collabora editor URL (with version hash)
  const editorUrl = await getCollaboraEditorUrl();

  console.log(`[driveEditor] Collabora config for user ${user._id} (mode: ${canEdit ? 'edit' : 'view'})`);

  return {
    collaboraUrl: COLLABORA_URL,
    editorUrl,
    wopiSrc,
    accessToken,
    accessTokenTTL,
    fileName: file.file_name,
    fileType: ext,
    _permissions: {
      canEdit,
      canView: true,
      canDownload: !!permissions.can_download,
    },
  };
};

/* ───────────── Generate Editor Page Token (for mobile WebView) ───────────── */

const generateEditorPageToken = async ({ user, project, params }) => {
  const config = await getEditorConfig({ user, project, params });

  const token = jwt.sign(
    { type: 'editor_page', config },
    WOPI_SECRET,
    { expiresIn: '5m' },
  );

  return { token };
};

/* ───────────── Serve Editor Page (for mobile WebView) ───────────── */

const getEditorPage = async ({ params, query }) => {
  const { token } = query;
  if (!token) throw new BadRequest('missing_editor_page_token');

  let payload;
  try {
    payload = jwt.verify(token, WOPI_SECRET);
  } catch {
    throw new BadRequest('invalid_or_expired_editor_page_token');
  }

  if (payload.type !== 'editor_page' || !payload.config) {
    throw new BadRequest('invalid_editor_page_token_payload');
  }

  const { editorUrl, collaboraUrl, wopiSrc, accessToken, fileName } = payload.config;
  const baseUrl = editorUrl || `${collaboraUrl}/browser/dist/cool.html`;
  const iframeSrc = `${baseUrl}?WOPISrc=${encodeURIComponent(wopiSrc)}&access_token=${encodeURIComponent(accessToken)}&NotWOPIButIframe=true`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${escapeHtml(fileName || 'Editor')}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; }
    iframe { width: 100vw; height: 100vh; border: none; }
  </style>
</head>
<body>
  <iframe id="collabora-frame"
    src="${escapeHtml(iframeSrc)}"
    allow="clipboard-read; clipboard-write"
    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation allow-popups-to-escape-sandbox"
  ></iframe>
  <script>
    window.addEventListener('message', function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.MessageId === 'UI_Close') {
          window.close();
        }
      } catch(ex) {}
    });
  </script>
</body>
</html>`;

  return html;
};

const escapeHtml = (str) => {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

export default {
  getEditorConfig,
  generateEditorPageToken,
  getEditorPage,
};
