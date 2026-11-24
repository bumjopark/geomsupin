// 사내망 HTTPS: 도메인 없이 IP 주소로 검수핀을 https 로 서비스한다(sudo 불필요).
//   node scripts/tls-setup.mjs --host 10.0.0.5 --port 3443
//
// 왜 필요한가: 검수 대상 페이지가 https 이면 브라우저는 http 로 서비스하는 검수핀의 스크립트·통신을 막는다(혼합 콘텐츠).
// HTTPS로 서비스하는 사이트를 미리보기에 연결할 때 검수핀도 HTTPS로 제공한다.
//
// 하는 일(.local/tls 아래, 이미 있으면 재사용):
//   1) 사내 전용 CA 를 만든다. 이 CA 는 지정한 IP 에 대한 인증서만 발급할 수 있게(nameConstraints) 제한해, 키가 새도 다른 사이트를 가장할 수 없다.
//   2) 그 IP 의 서버 인증서를 발급한다.
//   3) 사용자 권한 nginx(포트 --port)가 https 를 받아 검수핀(--upstream)으로 넘기게 설정한다. 공용 nginx 는 건드리지 않는다.
//   4) systemd 사용자 서비스 geomsupin-tls 로 등록해 시작한다(--no-service 이면 파일만 만든다).
// PC 에서 경고 없이 쓰려면 ca.crt(https://<주소>:<포트>/gp-ca.crt 로도 내려받을 수 있다)를 한 번 설치한다. 자세한 절차는 deploy/onprem/README.md.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertUnitOwnership, readInstallation, unitDir, unitMarker } from './installation-settings.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);
const { env, instance, prefix } = readInstallation(root);
if (instance === 'http') throw new Error('HTTP 보조 설치에서는 TLS를 설정할 수 없습니다. HTTPS 설치 폴더를 사용하세요.');
const unitName = `${prefix}-tls.service`;
if (!flag('no-service')) assertUnitOwnership(root, prefix, [`${prefix}-api.service`, unitName]);

const host = option('host');
if (!host || !/^[A-Za-z0-9.-]+$/.test(host)) {
  console.error('usage: node scripts/tls-setup.mjs --host <IP 또는 호스트명> [--port 3443] [--upstream 127.0.0.1:3200] [--dir .local/tls] [--renew] [--no-service]');
  process.exit(1);
}
const port = Number(option('port', '3443'));
if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('--port 는 1024~65535 사이여야 합니다(사용자 권한 nginx 는 1024 미만 포트를 쓸 수 없습니다)'); process.exit(1); }
const envPort = env.PORT;
const upstream = option('upstream', `127.0.0.1:${envPort || '3200'}`);
const dir = resolve(root, option('dir', '.local/tls'));
const nginxDir = join(dir, 'nginx');
const openssl = (...a) => execFileSync('openssl', a, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const san = isIPv4(host) ? `IP:${host}` : `DNS:${host}`;
// nameConstraints 는 이름 종류(IP·DNS)마다 따로 적용된다. IP 만 허용하면 DNS 이름은 제한이 없어 다른 사이트 이름의 인증서도 통과하므로,
// 두 종류 모두 허용 목록을 둔다(IP 주소를 쓸 때 DNS 는 localhost 하나만 허용한다).
const permitted = isIPv4(host)
  ? [`permitted;IP:${host}/255.255.255.255`, 'permitted;IP:127.0.0.1/255.255.255.255', 'permitted;DNS:localhost']
  : [`permitted;DNS:${host}`, 'permitted;IP:127.0.0.1/255.255.255.255'];

mkdirSync(dir, { recursive: true, mode: 0o700 });
mkdirSync(nginxDir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const file = (name) => join(dir, name);

// 1) CA: 이미 있으면 그대로 쓴다(이미 PC 에 설치한 CA 를 바꾸지 않는다).
if (!existsSync(file('ca.key')) || !existsSync(file('ca.crt'))) {
  openssl('genrsa', '-out', file('ca.key'), '3072');
  chmodSync(file('ca.key'), 0o600);
  openssl('req', '-x509', '-new', '-key', file('ca.key'), '-sha256', '-days', '3650',
    '-subj', '/O=Geomsupin/CN=Geomsupin Internal CA', '-out', file('ca.crt'),
    '-addext', 'basicConstraints=critical,CA:true,pathlen:0',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-addext', `nameConstraints=critical,${permitted.join(',')}`);
  console.log('새 사내 CA 를 만들었습니다(유효 10년).');
}

// 2) 서버 인증서: 없거나 --renew 이거나 다른 주소용이면 새로 발급한다.
// DNS:localhost 를 함께 둔다: OpenSSL 계열(curl 등)은 DNS 이름이 없으면 주체 CN 을 호스트명으로 보고 nameConstraints 에 대조한다.
const sansWanted = isIPv4(host) ? `${san},IP:127.0.0.1,DNS:localhost` : `${san},IP:127.0.0.1`;
const leafMatches = () => {
  if (!existsSync(file('gp.crt'))) return false;
  try { return openssl('x509', '-in', file('gp.crt'), '-noout', '-ext', 'subjectAltName').includes(host); } catch { return false; }
};
if (flag('renew') || !leafMatches()) {
  openssl('genrsa', '-out', file('gp.key'), '2048');
  chmodSync(file('gp.key'), 0o600);
  openssl('req', '-new', '-key', file('gp.key'), '-subj', '/O=Geomsupin/CN=Geomsupin Server', '-out', file('gp.csr'));
  writeFileSync(file('gp.ext'), [
    `subjectAltName=${sansWanted}`, 'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth', 'subjectKeyIdentifier=hash', 'authorityKeyIdentifier=keyid',
  ].join('\n') + '\n');
  // 825일: 사내에 설치한 CA 는 브라우저의 398일 제한 대상이 아니고, macOS 의 825일 제한 안에 든다.
  openssl('x509', '-req', '-in', file('gp.csr'), '-CA', file('ca.crt'), '-CAkey', file('ca.key'), '-CAcreateserial', '-out', file('gp.crt'), '-days', '825', '-sha256', '-extfile', file('gp.ext'));
  rmSync(file('gp.csr'), { force: true });
  console.log(`서버 인증서를 발급했습니다: ${host} (유효 825일)`);
}
// 발급한 인증서가 CA 로 검증되고 주소가 맞는지 확인한다(nameConstraints 위반 등을 여기서 잡는다).
try { openssl('verify', '-CAfile', file('ca.crt'), file('gp.crt')); } catch (e) { console.error('인증서 검증 실패:', e.stderr?.toString() || e.message); process.exit(1); }
if (isIPv4(host)) {
  try { openssl('verify', '-CAfile', file('ca.crt'), '-verify_ip', host, file('gp.crt')); } catch (e) { console.error('인증서의 IP 일치 검증 실패:', e.stderr?.toString() || e.message); process.exit(1); }
}

// 3) nginx 설정(사용자 권한). 접속 기록은 남기지 않는다(주소에 초대 토큰이 들어 있다).
const conf = `# 자동 생성(scripts/tls-setup.mjs): 사용자 권한 nginx — https ${host}:${port} → http ${upstream}
worker_processes 1;
pid ${nginxDir}/nginx.pid;
error_log ${nginxDir}/error.log warn;
events { worker_connections 1024; }
http {
  access_log off;
  client_body_temp_path ${nginxDir}/body;
  proxy_temp_path ${nginxDir}/proxy;
  fastcgi_temp_path ${nginxDir}/fastcgi;
  uwsgi_temp_path ${nginxDir}/uwsgi;
  scgi_temp_path ${nginxDir}/scgi;
  client_max_body_size 20m;
  server_tokens off;
  server {
    listen ${port} ssl;
    server_name _;
    ssl_certificate ${file('gp.crt')};
    ssl_certificate_key ${file('gp.key')};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:2m;
    ssl_session_timeout 1h;
    # PC 에 설치할 사내 CA 인증서(공개 정보)
    location = /gp-ca.crt {
      alias ${file('ca.crt')};
      default_type application/x-x509-ca-cert;
      add_header Content-Disposition 'attachment; filename="geomsupin-ca.crt"';
      add_header Cache-Control "no-store";
    }
    location / {
      proxy_pass http://${upstream};
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_set_header Host $http_host;
      # 앱은 로컬 접속일 때 이 헤더를 실제 접속자 주소로 쓴다(접속자별 요청 제한). nginx 가 항상 덮어쓴다.
      proxy_set_header CF-Connecting-IP $remote_addr;
      proxy_set_header X-Forwarded-Proto https;
      proxy_read_timeout 60s;
    }
  }
}
`;
writeFileSync(join(nginxDir, 'nginx.conf'), conf, { mode: 0o600 });
const nginxCommand = ['/usr/sbin/nginx', '-p', `${nginxDir}/`, '-e', `${nginxDir}/error.log`, '-c', `${nginxDir}/nginx.conf`];
try { execFileSync(nginxCommand[0], [...nginxCommand.slice(1), '-t'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
catch (e) { console.error('nginx 설정 검사 실패:\n' + (e.stderr?.toString() || e.message)); process.exit(1); }

// 4) systemd 사용자 서비스
const unitPath = join(unitDir(), unitName);
const unit = `${unitMarker(root)}
[Unit]
Description=Geomsupin HTTPS 프록시 (nginx, 사용자 권한, ${host}:${port})
After=network.target ${prefix}-api.service

[Service]
Type=simple
ExecStart=${nginxCommand.join(' ')} -g 'daemon off;'
Restart=always
RestartSec=3
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`;
if (flag('no-service')) {
  console.log(`\n서비스 등록은 건너뛰었습니다(--no-service). 직접 실행: ${nginxCommand.join(' ')} -g 'daemon off;'`);
} else {
  mkdirSync(unitDir(), { recursive: true });
  writeFileSync(unitPath, unit);
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  execFileSync('systemctl', ['--user', 'enable', unitName], { stdio: 'inherit' });
  execFileSync('systemctl', ['--user', 'restart', unitName], { stdio: 'inherit' });
  console.log(`\n${unitName} 서비스를 시작했습니다.`);
}

const fingerprint = openssl('x509', '-in', file('ca.crt'), '-noout', '-fingerprint', '-sha256').trim().replace(/^.*=/, '');
const expires = openssl('x509', '-in', file('gp.crt'), '-noout', '-enddate').trim().replace('notAfter=', '');
console.log(`
주소: https://${host}:${port}
CA 인증서 파일: ${file('ca.crt')}
  내려받기: https://${host}:${port}/gp-ca.crt
  SHA-256 지문(설치 전에 이 값과 같은지 확인): ${fingerprint}
서버 인증서 만료: ${expires}  (다시 발급: node scripts/tls-setup.mjs --host ${host} --port ${port} --renew)
검수핀 공개 주소를 변경한 경우: node scripts/set-hosts.mjs https://${host}:${port}  →  systemctl --user restart ${prefix}-api`);
