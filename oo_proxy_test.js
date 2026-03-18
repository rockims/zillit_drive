const crypto = require("crypto");
const http = require("http");
const https = require("https");
const fs = require("fs");
const jwt = require("jsonwebtoken");

const SECRET = "Brxd-7fAiRQFYz2eI81ZLzCxJwf7BjTsMjyx-_PH5op=";
const IV = SECRET.substring(0, 16);
const KEY = SECRET.substring(SECRET.length - 32);
const OO_SECRET = "zillit-onlyoffice-dev-secret-2024";

function aesEncrypt(text) {
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(KEY, "utf8"), Buffer.from(IV, "utf8"));
  return cipher.update(text, "utf8", "hex") + cipher.final("hex");
}
function bodyHash(body) {
  return crypto.createHash("sha256").update((typeof body === "string" ? body : JSON.stringify(body)) + IV).digest("hex");
}
function apiRequest(method, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "localhost", port: 8105, path, method, headers: { ...headers, "Content-Type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ raw: data.substring(0, 200) }); } });
    });
    req.on("error", reject);
    req.end();
  });
}

(async () => {
  const moduleData = JSON.stringify({ device_id: "b9c9869c49652ec7", project_id: "67f4cab3d7b27a11acfa570b", user_id: "67f7756c4db54aa7c6037ae1", scanner_device_id: "" });
  const headers = { moduledata: aesEncrypt(moduleData), bodyhash: bodyHash("{}") };
  const r1 = await apiRequest("GET", "/api/v2/drive/files", headers);
  const docx = (r1.data || []).find(f => f.file_extension === "docx");
  const r2 = await apiRequest("GET", "/api/v2/drive/editor/" + docx._id + "/config", headers);
  const origConfig = r2.data;
  const s3Url = origConfig.document.url;
  
  // Create a proxy URL that OnlyOffice Docker can reach via host.docker.internal
  // The proxy URL is simpler and avoids any issues with long presigned URLs
  const PROXY_PORT = 9998;
  const proxyUrl = `http://host.docker.internal:${PROXY_PORT}/document.docx`;
  
  // Build new config with proxy URL
  const newConfig = {
    document: {
      fileType: origConfig.document.fileType,
      key: origConfig.document.key,
      title: origConfig.document.title,
      url: proxyUrl,
    },
    documentType: origConfig.documentType,
    editorConfig: origConfig.editorConfig,
  };
  
  // Sign with OnlyOffice JWT
  const token = jwt.sign(newConfig, OO_SECRET, { expiresIn: "1h" });
  newConfig.token = token;
  
  console.log("Original S3 URL:", s3Url.substring(0, 80) + "...");
  console.log("Proxy URL:", proxyUrl);
  
  // Start proxy server that serves the S3 file
  const proxyServer = http.createServer((req, res) => {
    if (req.url === "/document.docx") {
      console.log("[Proxy] Serving document from S3...");
      const urlObj = new URL(s3Url);
      https.get(urlObj, (s3Res) => {
        console.log("[Proxy] S3 status:", s3Res.statusCode);
        res.writeHead(s3Res.statusCode, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Length": s3Res.headers["content-length"],
          "Access-Control-Allow-Origin": "*",
        });
        s3Res.pipe(res);
      }).on("error", (e) => {
        console.error("[Proxy] S3 error:", e.message);
        res.writeHead(500);
        res.end("S3 error");
      });
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  proxyServer.listen(PROXY_PORT, () => console.log("[Proxy] Serving on port", PROXY_PORT));
  
  const configJson = JSON.stringify(newConfig, null, 2);
  
  const html = `<!DOCTYPE html>
<html>
<head><title>OnlyOffice Test (Proxy)</title></head>
<body>
<h2>OnlyOffice Editor Test (via Proxy URL)</h2>
<div id="status" style="padding:10px;background:#ffe;border:1px solid #cc0;margin:10px 0;">Loading OnlyOffice API...</div>
<div id="editor" style="width:100%;height:80vh;border:1px solid #ccc;"></div>
<script>
  var statusEl = document.getElementById("status");
  var script = document.createElement("script");
  script.src = "http://localhost:8080/web-apps/apps/api/documents/api.js";
  script.onload = function() {
    statusEl.textContent = "API loaded. DocsAPI: " + (typeof DocsAPI !== "undefined");
    if (typeof DocsAPI === "undefined") { statusEl.textContent = "ERROR: DocsAPI undefined"; return; }
    try {
      var editorConfig = ${configJson};
      editorConfig.width = "100%";
      editorConfig.height = "100%";
      editorConfig.events = {
        onAppReady: function() { statusEl.textContent = "onAppReady! Waiting for document..."; },
        onDocumentReady: function() { statusEl.textContent = "Document loaded!"; statusEl.style.background = "#dfd"; },
        onError: function(e) { statusEl.textContent = "ERROR: " + JSON.stringify(e && e.data); statusEl.style.background = "#fdd"; console.error("onError", e); },
        onWarning: function(e) { console.warn("onWarning", e); }
      };
      statusEl.textContent = "Creating DocEditor with proxy URL...";
      var editor = new DocsAPI.DocEditor("editor", editorConfig);
      statusEl.textContent = "DocEditor created, waiting...";
    } catch(e) {
      statusEl.textContent = "Error: " + e.message;
      statusEl.style.background = "#fdd";
    }
  };
  script.onerror = function() { statusEl.textContent = "Failed to load OnlyOffice API"; statusEl.style.background = "#fdd"; };
  document.head.appendChild(script);
</script>
</body>
</html>`;
  
  // Serve test page
  const testServer = http.createServer((req, res) => {
    res.writeHead(200, {"Content-Type": "text/html"});
    res.end(html);
  });
  testServer.listen(9999, () => {
    console.log("[Test] Page at http://localhost:9999");
    console.log("Open in browser!");
  });
})().catch(err => console.error("Error:", err.message));
