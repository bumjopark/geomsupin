import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { join } from 'node:path';

/** Temporary HTTPS endpoints resolved only inside the isolated Chromium recording. */
export async function tutorialHttps(work: string, hosts: Record<string, number>, homepage?: { host: string; html: Buffer }) {
  const keyPath = join(work, 'site.key');
  const certPath = join(work, 'site.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=Geomsupin recording', '-addext', 'basicConstraints=critical,CA:FALSE',
    '-addext', `subjectAltName=${Object.keys(hosts).map(host => `DNS:${host}`).join(',')}`,
    '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
  const cert = await readFile(certPath);
  const spki = new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyPin = createHash('sha256').update(spki).digest('base64');

  const server = createServer({ key: await readFile(keyPath), cert }, (req, res) => {
    const port = hosts[req.headers.host ?? ''];
    if (!Number.isInteger(port)) { res.writeHead(421).end(); return; }
    if (homepage && req.headers.host === homepage.host && req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(homepage.html);
      return;
    }
    const upstream = request({ hostname: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers });
    upstream.once('response', response => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.once('error', () => {
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end();
    });
    res.once('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind the tutorial HTTPS server');
  return {
    publicKeyPin,
    resolver: Object.keys(hosts).map(host => `MAP ${host}:443 127.0.0.1:${address.port}`).join(', '),
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
