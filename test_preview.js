const crypto = require('crypto');
const mongoose = require('mongoose');
const http = require('http');
const https = require('https');

const DB_URL = 'mongodb://zillit_user:quite5092meat@54.152.44.50/zillit_dev?authSource=admin';
const SECRET = 'Brxd-7fAiRQFYz2eI81ZLzCxJwf7BjTsMjyx-_PH5op=';
const IV = SECRET.substring(0, 16);
const KEY = SECRET.substring(SECRET.length - 32);
const DEVICE_ID = 'b9c9869c49652ec7';
const PROJECT_ID = '67f4cab3d7b27a11acfa570b';
const USER_ID = '67f7756c4db54aa7c6037ae1'; // project user _id

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
        try { resolve(JSON.parse(data)); } catch(e) { resolve({ raw: data.substring(0, 500) }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const moduleData = JSON.stringify({
    device_id: DEVICE_ID,
    project_id: PROJECT_ID,
    user_id: USER_ID,
    scanner_device_id: ''
  });
  const encrypted = aesEncrypt(moduleData);
  const bh = bodyHash('{}');
  const headers = { moduledata: encrypted, bodyhash: bh };

  // Test 1: List files
  console.log('=== GET /files ===');
  const r1 = await apiRequest('GET', '/api/v2/drive/files', headers);
  console.log('Status:', r1.status, '| Message:', r1.message);
  const files = r1.data || [];
  console.log('Files:', files.length);
  files.forEach(f => console.log(`  ${f.file_name} (.${f.file_extension}) | ${f.file_size} | id: ${f._id}`));

  // Test 2: Preview each file
  console.log('\n=== Preview URLs ===');
  for (const f of files) {
    const rp = await apiRequest('GET', `/api/v2/drive/files/${f._id}/preview`, headers);
    const icon = rp.status === 1 ? '✅' : '❌';
    let s3Info = '';
    if (rp.data && rp.data.url) {
      const url = new URL(rp.data.url);
      const res = await new Promise((resolve, reject) => {
        https.get(url, (r) => {
          let sz = 0; r.on('data', (c) => sz += c.length);
          r.on('end', () => resolve({ s: r.statusCode, ct: r.headers['content-type'], sz }));
        }).on('error', reject);
      });
      s3Info = `| S3: ${res.s} ${res.ct} ${res.sz}b`;
    }
    console.log(`${icon} ${f.file_name} (.${f.file_extension}): ${rp.status === 1 ? 'OK' : rp.message} ${s3Info}`);
  }

  // Test 3: OnlyOffice for .docx
  const docx = files.find(f => f.file_extension === 'docx');
  if (docx) {
    console.log(`\n=== OnlyOffice: ${docx.file_name} ===`);
    const r3 = await apiRequest('GET', `/api/v2/drive/editor/${docx._id}/config`, headers);
    console.log('Status:', r3.status, '| Message:', r3.message);
    if (r3.data) {
      console.log('✅ Editor config received!');
      console.log('  documentType:', r3.data.documentType);
      console.log('  fileType:', r3.data.document?.fileType);
      console.log('  title:', r3.data.document?.title);
      console.log('  has token:', !!r3.data.token);
      console.log('  callbackUrl:', r3.data.editorConfig?.callbackUrl);
    }
  }

  // Test 4: Stream vs Preview
  if (files.length > 0) {
    const f = files[0];
    console.log(`\n=== Stream vs Preview: ${f.file_name} ===`);
    const stream = await apiRequest('GET', `/api/v2/drive/files/${f._id}/stream`, headers);
    const preview = await apiRequest('GET', `/api/v2/drive/files/${f._id}/preview`, headers);
    console.log('Stream (download):', stream.status === 1 ? '✅' : `❌ ${stream.message}`);
    console.log('Preview (view):   ', preview.status === 1 ? '✅' : `❌ ${preview.message}`);
  }

  console.log('\n✅ Tests complete');
})().catch(err => { console.error('Error:', err.message); process.exit(1); });
