const jwt = require('jsonwebtoken');
const http = require('http');

const JWT_SECRET = 'zillit-onlyoffice-dev-secret-2024';
const DOC_KEY = `test_${Date.now()}`;
const DOC_URL = 'https://zillit-bucket-mumbai-dev.s3.ap-south-1.amazonaws.com/someproject/test.docx';

const config = {
  document: { fileType: 'docx', key: DOC_KEY, title: 'test.docx', url: DOC_URL },
  documentType: 'word',
  editorConfig: {
    callbackUrl: 'http://host.docker.internal:8105/api/v2/drive/editor/callback?fileId=test',
    user: { id: 'testuser123', name: 'Test User' },
    mode: 'edit',
  },
};

const token = jwt.sign(config, JWT_SECRET, { expiresIn: '1h' });
console.log('Document key:', DOC_KEY);

function httpReq(url, method, body, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { resolve({ status: 0, data: '(timeout)' }); }, timeout || 5000);
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
  // Handshake
  const hs = await httpReq(`http://localhost:8080/doc/${DOC_KEY}/socket.io/?EIO=4&transport=polling`);
  const sid = hs.data.match(/"sid":"([^"]+)"/)?.[1];
  console.log('SID:', sid);
  
  const base = `http://localhost:8080/doc/${DOC_KEY}/socket.io/?EIO=4&transport=polling&sid=${sid}`;
  
  // Send "40" with token for namespace connection
  const ns = await httpReq(base, 'POST', `40{"token":"${token}"}`, 3000);
  console.log('NS response:', ns.status, ns.data);
  
  // Poll for namespace ack
  const p1 = await httpReq(base, 'GET', null, 5000);
  console.log('Poll 1:', p1.data.substring(0, 500));
  
  // If we got namespace connected (40), send auth message
  const authPayload = JSON.stringify({
    type: "auth",
    token: token,
    editorType: 0,
    lastOtherReceivedIndex: -1,
    openCmd: { c: "open", id: DOC_KEY, userid: "testuser123", format: "docx", url: DOC_URL, title: "test.docx", token: token },
  });
  
  const authRes = await httpReq(base, 'POST', `42["message",${JSON.stringify(authPayload)}]`, 3000);
  console.log('Auth post:', authRes.status, authRes.data);
  
  // Poll for auth response
  const p2 = await httpReq(base, 'GET', null, 8000);
  console.log('Poll 2 (auth resp):', p2.data.substring(0, 1000));
}

main().catch(e => console.error('ERROR:', e.message));
setTimeout(() => process.exit(0), 25000);
