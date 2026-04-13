const jwt = require('jsonwebtoken');
const http = require('http');

const JWT_SECRET = 'zillit-onlyoffice-dev-secret-2024';
const DOC_KEY = 'testdoc' + Date.now();
const CACHE_TAG = process.argv[2] || '9.3.1-fa523677c8d97c016cd6f5bc6ef1e9f2';

const config = {
  document: { fileType: 'docx', key: DOC_KEY, title: 'test.docx', url: 'https://example.com/test.docx' },
  documentType: 'word',
  editorConfig: {
    callbackUrl: 'http://host.docker.internal:8105/api/v2/drive/editor/callback',
    user: { id: 'testuser123', name: 'Test User' },
    mode: 'edit',
  },
};
const token = jwt.sign(config, JWT_SECRET, { expiresIn: '1h' });

function httpReq(url, method, body, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ status: 0, data: '(timeout)' }), timeout || 5000);
    const opts = method === 'POST' ? { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' } } : {};
    const req = http.request(url, opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, data }); });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    if (body) req.write(body);
    req.end();
  });
}

async function test(prefix) {
  const path = prefix ? `/${CACHE_TAG}/doc/${DOC_KEY}/socket.io` : `/doc/${DOC_KEY}/socket.io`;
  console.log(`\nTesting path: ${path}`);
  
  const hs = await httpReq(`http://localhost:8080${path}/?EIO=4&transport=polling`);
  const sid = hs.data.match(/"sid":"([^"]+)"/)?.[1];
  if (!sid) { console.log('NO SID - handshake:', hs.data.substring(0, 100)); return; }
  
  const base = `http://localhost:8080${path}/?EIO=4&transport=polling&sid=${sid}`;
  await httpReq(base, 'POST', `40{"token":"${token}"}`, 3000);
  const p = await httpReq(base, 'GET', null, 3000);
  const hasError = p.data.includes('disconnectReason') || p.data.includes('access deny');
  console.log(hasError ? `REJECTED: ${p.data.substring(0, 200)}` : `OK: ${p.data.substring(0, 200)}`);
}

async function main() {
  await test(false); // Without version prefix
  await test(true);  // With version prefix
}
main().catch(e => console.error(e));
setTimeout(() => process.exit(0), 15000);
