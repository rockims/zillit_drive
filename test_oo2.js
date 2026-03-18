const jwt = require('jsonwebtoken');
const http = require('http');

const JWT_SECRET = 'zillit-onlyoffice-dev-secret-2024';

// Try different key formats to find what works
const keys = [
  'abc123',               // simple alphanumeric
  'abc-123',              // with dash
  'abc.123',              // with dot
  'testkey',              // just letters
  '69b397a9a12e49f9a64209fb1773472905151',  // no underscore (combined)
];

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

async function testKey(docKey) {
  const config = {
    document: { fileType: 'docx', key: docKey, title: 'test.docx', url: 'https://example.com/test.docx' },
    documentType: 'word',
    editorConfig: {
      callbackUrl: 'http://host.docker.internal:8105/api/v2/drive/editor/callback',
      user: { id: 'testuser123', name: 'Test User' },
      mode: 'edit',
    },
  };
  const token = jwt.sign(config, JWT_SECRET, { expiresIn: '1h' });

  // Handshake
  const hs = await httpReq(`http://localhost:8080/doc/${docKey}/socket.io/?EIO=4&transport=polling`);
  const sid = hs.data.match(/"sid":"([^"]+)"/)?.[1];
  if (!sid) { console.log(`Key "${docKey}": NO SID`); return; }
  
  const base = `http://localhost:8080/doc/${docKey}/socket.io/?EIO=4&transport=polling&sid=${sid}`;
  
  // NS connect with token  
  await httpReq(base, 'POST', `40{"token":"${token}"}`, 3000);
  
  // Poll for response
  const p = await httpReq(base, 'GET', null, 3000);
  const hasError = p.data.includes('disconnectReason') || p.data.includes('access deny');
  console.log(`Key "${docKey}": ${hasError ? 'REJECTED - ' + p.data.substring(0, 150) : 'OK - ' + p.data.substring(0, 150)}`);
}

async function main() {
  for (const key of keys) {
    await testKey(key);
  }
}
main().catch(e => console.error(e));
setTimeout(() => process.exit(0), 30000);
