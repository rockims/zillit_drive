const crypto = require('crypto');
const http = require('http');

const SECRET = 'Brxd-7fAiRQFYz2eI81ZLzCxJwf7BjTsMjyx-_PH5op=';
const IV = SECRET.substring(0, 16);
const KEY = SECRET.substring(SECRET.length - 32);
const DEVICE_ID = 'b9c9869c49652ec7';
const PROJECT_ID = '67f4cab3d7b27a11acfa570b';
const BASE = '/api';

function aesEncrypt(text) {
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(KEY, 'utf8'), Buffer.from(IV, 'utf8'));
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

function bodyHash(body) {
  const saltedInput = (typeof body === 'string' ? body : JSON.stringify(body)) + IV;
  return crypto.createHash('sha256').update(saltedInput).digest('hex');
}

function apiRequest(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost', port: 8105, path, method,
      headers: { ...headers, 'Content-Type': 'application/json' },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ statusCode: res.statusCode, body: { raw: data.substring(0, 500) } }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function makeHeaders(userId) {
  const moduleData = JSON.stringify({
    device_id: DEVICE_ID,
    project_id: PROJECT_ID,
    user_id: userId,
    scanner_device_id: ''
  });
  const encrypted = aesEncrypt(moduleData);
  const bh = bodyHash('{}');
  return { moduledata: encrypted, bodyhash: bh };
}

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${testName}`);
  } else {
    failed++;
    console.log(`  FAIL: ${testName}`);
  }
}

(async () => {
  console.log('==========================================================');
  console.log('  Zillit Drive - Comprehensive Permission Tests');
  console.log('==========================================================\n');

  // ------------------------------------------------------------------
  // Step 1: List files and find a docx file
  // ------------------------------------------------------------------
  console.log('--- Step 1: List files ---');
  const headers = makeHeaders('67f7756c4db54aa7c6037ae1'); // owner user
  const listRes = await apiRequest('GET', `${BASE}/v2/drive/files`, headers);

  assert(listRes.body.status === 1, 'File list returns status 1');
  const files = listRes.body.data || [];
  console.log(`  Found ${files.length} file(s)`);
  files.forEach(f => console.log(`    - ${f.file_name} (.${f.file_extension}) id:${f._id}`));

  const docxFile = files.find(f => f.file_extension === 'docx');
  if (!docxFile) {
    console.log('\n  No .docx file found in project. Cannot run editor permission tests.');
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }

  console.log(`  Using docx file: "${docxFile.file_name}" (${docxFile._id})\n`);

  // ------------------------------------------------------------------
  // Step 2: Get file access list
  // ------------------------------------------------------------------
  console.log('--- Step 2: Get file access list ---');
  const accessRes = await apiRequest('GET', `${BASE}/v2/drive/file-access/${docxFile._id}/access`, headers);
  console.log(`  Access list status: ${accessRes.body.status}, message: ${accessRes.body.message}`);
  if (accessRes.body.data) {
    const accessList = Array.isArray(accessRes.body.data) ? accessRes.body.data : [accessRes.body.data];
    accessList.forEach(a => {
      console.log(`    User: ${a.user_id || a._id} | edit:${a.can_edit} view:${a.can_view} download:${a.can_download}`);
    });
  }
  console.log();

  // ------------------------------------------------------------------
  // Step 3: Test editor config (owner should have edit access)
  // ------------------------------------------------------------------
  console.log('--- Step 3: Editor config (owner) ---');
  const editorRes = await apiRequest('GET', `${BASE}/v2/drive/editor/${docxFile._id}/config`, headers);

  assert(editorRes.body.status === 1, 'Editor config returns status 1');
  assert(!!editorRes.body.data, 'Editor config returns data');

  const config = editorRes.body.data || {};

  // Check _permissions field
  assert(config._permissions !== undefined, '_permissions field exists in response');
  if (config._permissions) {
    assert(config._permissions.canEdit === true, '_permissions.canEdit is true for owner');
    assert(config._permissions.canView === true, '_permissions.canView is true for owner');
    assert(config._permissions.canDownload === true, '_permissions.canDownload is true for owner');
  }

  // Check editor mode
  assert(config.editorConfig?.mode === 'edit', 'Editor mode is "edit" for owner');

  // Check document.permissions
  const docPerms = config.document?.permissions || {};
  assert(docPerms.edit === true, 'document.permissions.edit is true for owner');
  assert(docPerms.download === true, 'document.permissions.download is true for owner');
  assert(docPerms.print === true, 'document.permissions.print is true for owner');
  assert(docPerms.copy === true, 'document.permissions.copy is true for owner');
  assert(docPerms.comment === true, 'document.permissions.comment is true for owner');
  assert(docPerms.review === true, 'document.permissions.review is true for owner');

  // Check document key and token
  assert(!!config.document?.key, 'Document key exists');
  assert(!!config.token, 'JWT token exists');

  // Check document URL has download token
  const docUrl = config.document?.url || '';
  assert(docUrl.includes('token='), 'Document URL contains download token');
  assert(docUrl.includes('key='), 'Document URL contains document key');

  // Check callback URL exists for editor
  assert(!!config.editorConfig?.callbackUrl, 'Callback URL exists for edit mode');

  // Check documentType
  assert(config.documentType === 'word', 'documentType is "word" for docx');

  // Check user info
  assert(!!config.editorConfig?.user?.id, 'User ID present in editor config');
  assert(!!config.editorConfig?.user?.name, 'User name present in editor config');

  console.log();

  // ------------------------------------------------------------------
  // Step 4: Test preview endpoint
  // ------------------------------------------------------------------
  console.log('--- Step 4: Preview endpoint ---');
  const previewRes = await apiRequest('GET', `${BASE}/v2/drive/files/${docxFile._id}/preview`, headers);
  assert(previewRes.body.status === 1, 'Preview returns status 1');
  assert(!!previewRes.body.data?.url, 'Preview returns a URL');
  console.log();

  // ------------------------------------------------------------------
  // Step 5: Test stream/download endpoint
  // ------------------------------------------------------------------
  console.log('--- Step 5: Stream/download endpoint ---');
  const streamRes = await apiRequest('GET', `${BASE}/v2/drive/files/${docxFile._id}/stream`, headers);
  assert(streamRes.body.status === 1, 'Stream returns status 1');
  assert(!!streamRes.body.data?.url, 'Stream returns a URL');
  console.log();

  // ------------------------------------------------------------------
  // Step 6: Co-editing key stability test
  // ------------------------------------------------------------------
  console.log('--- Step 6: Co-editing key stability ---');
  // Request editor config twice and verify the document key is the same
  // (since the file has not been modified between calls)
  const editorRes2 = await apiRequest('GET', `${BASE}/v2/drive/editor/${docxFile._id}/config`, headers);
  const key1 = config.document?.key;
  const key2 = editorRes2.body.data?.document?.key;
  assert(!!key1 && !!key2 && key1 === key2,
    `Document key is stable across requests (key1=${key1}, key2=${key2})`);
  console.log();

  // ------------------------------------------------------------------
  // Step 7: Verify HMAC token consistency with stable key
  // ------------------------------------------------------------------
  console.log('--- Step 7: HMAC download token consistency ---');
  const url1 = config.document?.url || '';
  const url2 = editorRes2.body.data?.document?.url || '';
  const token1 = new URL(url1, 'http://localhost').searchParams.get('token');
  const token2 = new URL(url2, 'http://localhost').searchParams.get('token');
  assert(!!token1 && !!token2 && token1 === token2,
    'HMAC download token is identical for same document key');
  console.log();

  // ------------------------------------------------------------------
  // Step 8: Test with other files (non-docx if any)
  // ------------------------------------------------------------------
  console.log('--- Step 8: Non-editable file types ---');
  const nonEditableExts = ['jpg', 'jpeg', 'png', 'gif', 'pdf', 'zip', 'mp4'];
  const nonEditableFile = files.find(f => nonEditableExts.includes((f.file_extension || '').toLowerCase()));
  if (nonEditableFile) {
    const neRes = await apiRequest('GET', `${BASE}/v2/drive/editor/${nonEditableFile._id}/config`, headers);
    assert(neRes.body.status !== 1 || neRes.body.message?.includes('not_editable') || neRes.statusCode >= 400,
      `Non-editable file type (.${nonEditableFile.file_extension}) is rejected by editor`);
  } else {
    console.log('  SKIP: No non-editable file found to test');
  }
  console.log();

  // ------------------------------------------------------------------
  // Step 9: Test editor config with non-existent file
  // ------------------------------------------------------------------
  console.log('--- Step 9: Edge cases ---');
  const fakeId = '000000000000000000000000';
  const fakeRes = await apiRequest('GET', `${BASE}/v2/drive/editor/${fakeId}/config`, headers);
  assert(fakeRes.body.status !== 1, 'Non-existent file returns error');
  console.log();

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  console.log('==========================================================');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('==========================================================');

  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
