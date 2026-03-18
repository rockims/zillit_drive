const jwt = require('jsonwebtoken');
const http = require('http');

const JWT_SECRET = 'zillit-onlyoffice-dev-secret-2024';
const DOC_KEY = 'testdoc' + Date.now();

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
console.log('Key:', DOC_KEY);

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

async function main() {
  // Use the socket.io path as the "path" option, not in the URL
  // OnlyOffice socket.io is configured with path: /doc/KEY/socket.io
  
  // Handshake  
  const hs = await httpReq(`http://localhost:8080/doc/${DOC_KEY}/socket.io/?EIO=4&transport=polling`);
  const sid = hs.data.match(/"sid":"([^"]+)"/)?.[1];
  console.log('SID:', sid);
  
  const base = `http://localhost:8080/doc/${DOC_KEY}/socket.io/?EIO=4&transport=polling&sid=${sid}`;
  
  // Try different namespace connect formats:
  const formats = [
    { name: 'Default NS with token', msg: `40{"token":"${token}"}` },
    { name: 'Named NS /doc/KEY with token', msg: `40/doc/${DOC_KEY},{"token":"${token}"}` },
    { name: 'Named NS / with token', msg: `40/,{"token":"${token}"}` },
  ];
  
  for (const fmt of formats) {
    console.log(`\nTrying: ${fmt.name}`);
    
    // Fresh handshake for each
    const h = await httpReq(`http://localhost:8080/doc/${DOC_KEY}/socket.io/?EIO=4&transport=polling`);
    const s = h.data.match(/"sid":"([^"]+)"/)?.[1];
    const b = `http://localhost:8080/doc/${DOC_KEY}/socket.io/?EIO=4&transport=polling&sid=${s}`;
    
    await httpReq(b, 'POST', fmt.msg, 3000);
    const p = await httpReq(b, 'GET', null, 5000);
    console.log('Response:', p.data.substring(0, 300));
  }
}

main().catch(e => console.error(e));
setTimeout(() => process.exit(0), 30000);
