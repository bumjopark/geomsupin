// 검수핀과 다른 출처에서 연결 스크립트와 외부 리소스를 시험하는 스테이징 서버.
//   사이트: 127.0.0.1:8202
//   CDN  : 127.0.0.1:8203   (교차 출처 자원 시험용, 로컬 검사 전용)
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2',
};

function safeFile(base, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const file = join(base, rel || 'index.html');
  if (!file.startsWith(base)) return null;
  if (existsSync(file) && statSync(file).isDirectory()) return join(file, 'index.html');
  return file;
}

export function startDemo({ sitePort = 8202, cdnPort = 8203, cdnOrigin, preview, log = true } = {}) {
  const siteBase = join(root, 'site');
  const cdnBase = join(root, 'cdn');
  const cdn = cdnOrigin || `http://127.0.0.1:${cdnPort}/demo-cdn`;

  const site = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const file = safeFile(siteBase, url.pathname);
    if (!file || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    const ext = extname(file);
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    if (ext === '.html') {
      // 엄격한 사이트 시험용: DEMO_CSP 를 주면 그 값을 Content-Security-Policy 로 보낸다.
      if (process.env.DEMO_CSP) res.setHeader('Content-Security-Policy', process.env.DEMO_CSP);
      let html = readFileSync(file, 'utf8').replaceAll('{{CDN}}', cdn).replaceAll('{{BASE}}', '/');
      if (preview) {
        if (!process.env.DEMO_CSP) res.setHeader('Content-Security-Policy', `frame-ancestors ${preview.appOrigin}`);
        html = html.replace('</head>', `<script defer src="${preview.appOrigin}/w.js" data-gp-preview="${preview.id}"></script></head>`);
      }
      res.end(html);
      return;
    }
    res.end(readFileSync(file));
  });

  const cdnServer = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const path = url.pathname.replace(/^\/demo-cdn/, '');
    const file = safeFile(cdnBase, path);
    const frame = join(siteBase, 'frame.html');
    const target = path === '/frame.html' ? frame : file;
    if (!target || !existsSync(target)) { res.writeHead(404); res.end('not found'); return; }
    res.setHeader('Content-Type', MIME[extname(target)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    if (path.startsWith('/cors/')) res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(readFileSync(target));
  });

  site.listen(sitePort, '127.0.0.1');
  cdnServer.listen(cdnPort, '127.0.0.1');
  if (log) console.log(`demo site  http://127.0.0.1:${sitePort}\ndemo cdn   http://127.0.0.1:${cdnPort}/demo-cdn`);
  return { site, cdnServer, close: () => { site.close(); cdnServer.close(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDemo({
    sitePort: Number(process.env.DEMO_PORT || 8202),
    cdnPort: Number(process.env.DEMO_CDN_PORT || 8203),
    cdnOrigin: process.env.DEMO_CDN_ORIGIN || undefined,
  });
}
