// M0 spike #3: local test server for the 30 s worker-survival measurements.
// THROWAWAY, removed before merge. Owner runs: npm run spike:server
//
// Endpoints (127.0.0.1:8123), all ~1 MB/s so each phase takes ~42 s with NO
// DevTools throttling needed:
//   GET  /slow-headers.png -> headers delayed 35 s, then 40 MiB fast.
//     Tests the documented kill condition "fetch() response takes >30 s to
//     arrive". Worker death shows as no [spike:30s] line in the console.
//   GET  /slow-body.png    -> headers immediately, body at ~1 MB/s (~42 s).
//   POST /slow-upload      -> reads a 40 MiB body at ~1 MB/s, replies "bytes=N".
//   GET  /iframe-site.html -> a page with an <img> and a cross-origin iframe
//                             (localhost vs 127.0.0.1) for the Q3 injection
//                             test. Open it via the OTHER hostname than the
//                             one in the address bar of the iframe.

import { createServer } from "node:http";

const PORT = 8123;
const TOTAL_BYTES = 40 * 1024 * 1024;
const CHUNK = 64 * 1024;
const CHUNK_DELAY_MS = 60; // 64 KiB per 60 ms ≈ 1.05 MiB/s ≈ 42 s for 40 MiB
const HEADER_DELAY_MS = 35_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The iframe page must load over the OPPOSITE origin of its parent, so the
// owner opens the parent via localhost and the iframe points at 127.0.0.1
// (or vice versa): the two hostnames are different origins.
const IFRAME_SITE_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>isthisai spike iframe page</title></head>
<body>
  <h3>isthisai spike: cross-origin iframe test (Q3)</h3>
  <p>Parent origin: <code id="origin"></code></p>
  <img src="/tiny.png" alt="tiny image in the parent" width="32">
  <iframe id="cross" width="640" height="360" title="cross-origin iframe with an image"></iframe>
  <script>
    document.getElementById("origin").textContent = location.origin;
    // Point the iframe at the other hostname: same port, different origin.
    const here = location.hostname;
    const other = here === "localhost" ? "127.0.0.1" : "localhost";
    document.getElementById("cross").src =
      location.protocol + "//" + other + ":" + location.port + "/iframe-img.html";
  </script>
</body>
</html>`;

const IFRAME_IMG_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>iframe inner</title></head>
<body style="background:#eee">
  <p>Inner origin: <code id="origin"></code></p>
  <img src="/tiny.png" alt="tiny image inside the cross-origin iframe" width="64">
  <script>document.getElementById("origin").textContent = location.origin;</script>
</body>
</html>`;

// 1x1 PNG (transparent), so the pages render without extra files.
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c626001000000ffff030000060005" +
    "57bfabd40000000049454e44ae426082",
  "hex",
);

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  try {
    if (req.method === "GET" && url === "/slow-headers.png") {
      console.log(`[spike-server] GET /slow-headers.png — headers in ${HEADER_DELAY_MS / 1000} s, then 40 MiB fast`);
      await sleep(HEADER_DELAY_MS);
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(TOTAL_BYTES) });
      let sent = 0;
      while (sent < TOTAL_BYTES) {
        const take = Math.min(CHUNK, TOTAL_BYTES - sent);
        res.write(Buffer.alloc(take, 0x89));
        sent += take;
      }
      res.end();
      console.log(`[spike-server] /slow-headers.png done, sent=${sent}`);
      return;
    }
    if (req.method === "GET" && url === "/slow-body.png") {
      console.log(`[spike-server] GET /slow-body.png — 40 MiB at ~1 MB/s (~42 s)`);
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(TOTAL_BYTES) });
      let sent = 0;
      while (sent < TOTAL_BYTES) {
        const take = Math.min(CHUNK, TOTAL_BYTES - sent);
        res.write(Buffer.alloc(take, 0x89));
        sent += take;
        await sleep(CHUNK_DELAY_MS);
      }
      res.end();
      console.log(`[spike-server] /slow-body.png done, sent=${sent}`);
      return;
    }
    if (req.method === "POST" && url === "/slow-upload") {
      console.log(`[spike-server] POST /slow-upload — reading 40 MiB at ~1 MB/s (~42 s)`);
      await new Promise((resolve, reject) => {
        let received = 0;
        let timer;
        const drain = () => {
          timer = setTimeout(() => {
            req.resume();
          }, CHUNK_DELAY_MS);
        };
        req.on("data", (chunk) => {
          received += chunk.length;
          req.pause();
          drain();
        });
        req.on("end", () => {
          if (timer) clearTimeout(timer);
          console.log(`[spike-server] /slow-upload done, received=${received}`);
          resolve();
        });
        req.on("error", reject);
      });
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`bytes=${TOTAL_BYTES}`);
      return;
    }
    if (req.method === "GET" && (url === "/" || url === "/iframe-site.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(IFRAME_SITE_HTML);
      return;
    }
    if (req.method === "GET" && url === "/iframe-img.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(IFRAME_IMG_HTML);
      return;
    }
    if (req.method === "GET" && url === "/tiny.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(TINY_PNG.length) });
      res.end(TINY_PNG);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("spike server: GET /slow-headers.png, GET /slow-body.png, POST /slow-upload, GET /iframe-site.html");
  } catch (e) {
    console.error("[spike-server] error:", e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[spike-server] listening on http://127.0.0.1:${PORT}`);
  console.log(`[spike-server] GET  /slow-headers.png : headers after 35 s, then 40 MiB fast`);
  console.log(`[spike-server] GET  /slow-body.png    : headers now, 40 MiB at ~1 MB/s (~42 s)`);
  console.log(`[spike-server] POST /slow-upload      : 40 MiB at ~1 MB/s, reply after ~42 s`);
});
