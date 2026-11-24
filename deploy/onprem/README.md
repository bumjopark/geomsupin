# 설치와 운영

검수핀 설치 서버에서 작업합니다. 참여자가 쓰는 브라우저에는 검수핀 북마크를 저장합니다. [화면으로 보는 사용법](../../docs/usage.md) · [English installation](../../README.en.md#1-prepare-the-linux-server)

## 설치 전 준비

설치 계정으로 서버에 접속합니다. 설치 계정은 Git 복제 폴더, `.env`, `data/`, `.local/`과 사용자 systemd 설정에 쓸 수 있어야 합니다. OS 패키지 설치와 시스템 프록시 설정에만 관리자 권한을 사용하세요. 소스 복제, npm, PostgreSQL 클러스터 초기화와 검수핀 서비스는 일반 계정으로 실행합니다. 처음 설치할 때는 이 계정에서 GitHub와 npm 레지스트리에 접속할 수 있어야 합니다.

Ubuntu 24.04 예시입니다. 다른 배포판에서는 PostgreSQL **16** 서버·클라이언트 패키지를 준비합니다. 기본 실행 파일 경로는 `/usr/lib/postgresql/16/bin`입니다. 다른 경로를 쓰면 설치 전에 `PG_BIN`을 그 디렉터리로 설정합니다. Node.js **22.12 이상**과 npm이 없다면 공식 다운로드에서 Linux용 패키지를 선택하세요. [PostgreSQL Linux 패키지](https://www.postgresql.org/download/) · [Node.js 공식 다운로드](https://nodejs.org/en/download)

```bash
sudo apt update
sudo apt install git curl ca-certificates xz-utils postgresql-16 postgresql-client-16
```

Node.js를 이 계정에 직접 설치할 경우 공식 다운로드에서 Node.js 22 LTS의 **Linux용 Standalone Binary (`.tar.xz`)**를 서버 CPU에 맞춰 받습니다. `uname -m`이 `x86_64`면 x64, `aarch64`면 arm64입니다. 내려받은 파일을 서버에 두고 Bash에서 절대경로를 입력합니다.

```bash
read -r -p 'Node.js .tar.xz 파일의 절대경로: ' GEOMSUPIN_NODE_ARCHIVE
mkdir -p "$HOME/.local/opt/geomsupin-node"
tar -xJf "$GEOMSUPIN_NODE_ARCHIVE" --strip-components=1 -C "$HOME/.local/opt/geomsupin-node"
export PATH="$HOME/.local/opt/geomsupin-node/bin:$PATH"
```

새 셸에서도 같은 Node.js를 사용하려면 위 `export PATH=…` 줄을 로그인 셸 설정에 넣거나 명령을 다시 실행합니다. 설치를 계속하기 전에 다음 출력을 확인합니다.

```bash
node --version
npm --version
/usr/lib/postgresql/16/bin/postgres --version
systemctl --user show-environment >/dev/null
```

마지막 명령에서 사용자 버스에 연결할 수 없다면 서버의 systemd 로그인 세션으로 설치 계정에 직접 접속해 다시 확인합니다. 로그아웃이나 재부팅 뒤에도 사용자 서비스를 유지하려면 설치 계정에서 `sudo loginctl enable-linger "$(id -un)"`을 실행합니다. 권한이 없는 경우 서버 관리자에게 해당 계정의 linger 활성화를 요청하세요.

GitHub의 **Code → HTTPS**에서 복사한 주소를 Bash 입력란에 붙여 넣습니다. 이후 명령은 `package.json`이 있는 복제 폴더에서 실행합니다.

```bash
read -r -p 'GitHub에서 복사한 HTTPS 주소: ' GEOMSUPIN_REPO_URL
git clone "$GEOMSUPIN_REPO_URL" geomsupin && cd geomsupin
npm ci --include=dev
```

검수핀과 검수할 사이트는 스킴·호스트·포트 중 적어도 하나가 다른 출처이며, 둘 다 HTTP 또는 둘 다 HTTPS여야 합니다. 참여자 PC가 양쪽 주소에 접근할 수 있게 DNS와 방화벽을 준비합니다. 프록시를 쓰면 참여자에게 공개하는 것은 프록시 HTTPS 포트입니다. API의 예시 포트 `3200`과 전용 DB의 기본 포트 `55433`은 서버의 루프백에서만 사용합니다. 검수 대상 사이트가 CSP를 적용한다면 그 사이트의 운영자가 검수핀 공개 출처에서 스크립트와 API를 불러올 수 있게 설정합니다.

## 처음 설치

### 사내 HTTP

두 사이트를 모두 사내 HTTP로 열 때 사용합니다. 서버의 실제 사내 주소를 입력하고, 참여자 네트워크에서 `3200/tcp`에 접속할 수 있게 설정합니다.

```bash
read -r -p '검수핀 서버의 사내 IPv4 주소: ' GEOMSUPIN_IP
npm run onprem:setup -- --url "http://${GEOMSUPIN_IP}:3200" --services
curl --fail --show-error "http://${GEOMSUPIN_IP}:3200/healthz"
```

설치기는 위젯과 관리 화면을 빌드하고 `.env`와 전용 PostgreSQL 클러스터를 만든 뒤 사용자 서비스를 시작합니다. `/healthz`가 `{"ok":true}`를 반환하면 API와 DB가 연결된 상태입니다.

### HTTPS 도메인과 리버스 프록시

조직의 HTTPS 도메인과 인증서를 쓸 때 선택합니다. `review.example.com`을 실제 도메인으로 바꾼 뒤 실행하세요. DNS에서 이 도메인이 프록시를 가리켜야 합니다.

```sh
npm run onprem:setup -- --url https://review.example.com --bind 127.0.0.1 --port 3200 --services
curl --fail --show-error http://127.0.0.1:3200/healthz
```

nginx와 API가 같은 호스트에 있는 예시입니다. 도메인과 인증서 경로를 환경에 맞게 바꿉니다. 기존 HTTPS 가상 호스트 안에 추가한다면 `server` 블록을 새로 중복 등록하지 않고 해당 설정을 병합하세요. `Host`는 공개 포트까지 보존합니다. 실시간 변경 알림은 SSE를 쓰고, 캡처 요청은 프록시의 본문 한도를 넘지 않아야 합니다. 접근 로그에서 토큰이 들어 있는 초대 주소를 제외하세요. [nginx HTTP 프록시 설정](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)

```nginx
server {
    listen 443 ssl;
    server_name review.example.com;
    ssl_certificate /etc/ssl/review/fullchain.pem;
    ssl_certificate_key /etc/ssl/review/privkey.pem;
    client_max_body_size 20m;
    access_log off;

    location / {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header CF-Connecting-IP $remote_addr;
        proxy_buffering off;
        proxy_read_timeout 60s;
    }
}
```

```sh
sudo nginx -t && sudo systemctl reload nginx
curl --fail --show-error https://review.example.com/healthz
```

참여자 PC에서도 같은 HTTPS 주소를 열어 인증서 경고 없이 `{"ok":true}`가 나오는지 확인합니다.

### 도메인 없이 IP로 HTTPS 사용

팀 PC에 사내 CA를 설치할 수 있을 때 사용합니다. 서버에 OpenSSL과 `/usr/sbin/nginx`가 필요합니다. Ubuntu에서는 `sudo apt install nginx openssl`로 설치합니다. 참여자에게는 HTTPS `3443/tcp`를 열고 API는 `127.0.0.1`에 둡니다.

```bash
read -r -p '검수핀 서버의 사내 IPv4 주소: ' GEOMSUPIN_IP
npm run onprem:setup -- --url "https://${GEOMSUPIN_IP}:3443" --bind 127.0.0.1 --port 3200 --services
node scripts/tls-setup.mjs --host "$GEOMSUPIN_IP" --port 3443
curl --fail --show-error --cacert .local/tls/ca.crt "https://${GEOMSUPIN_IP}:3443/healthz"
```

사용자 권한 nginx가 HTTPS 요청을 로컬 API로 전달합니다. TLS 도구는 `.local/tls/`에서 인증서를 만들거나 재사용합니다. 신뢰할 수 있는 통로로 **공개 CA 인증서** `ca.crt`만 팀 PC에 배포하고 설치 전에 스크립트가 출력한 SHA-256 지문과 대조합니다. 개인 키인 `ca.key`와 `gp.key`는 서버에 둡니다.

- **Windows**에서는 `ca.crt`를 열어 인증서 설치 → 현재 사용자 → 신뢰할 수 있는 루트 인증 기관을 선택합니다.
- **macOS**에서는 키체인 접근에 추가한 뒤 조직의 절차에 따라 해당 인증서를 신뢰하도록 설정합니다.
- **Linux**에서는 사용하는 배포판과 브라우저의 신뢰 저장소에 추가합니다. 팀 PC에서 브라우저를 다시 열고 검수핀과 스테이징 양쪽이 인증서 경고 없이 열리는지 확인합니다.

공개 인증서 다운로드 경로는 `/gp-ca.crt`입니다. 만료 전 서버 인증서를 갱신하려면 동일한 명령에 `--renew`를 붙입니다. IP를 변경한다면 새 주소에 맞는 CA와 서버 인증서를 준비하고 사용자 신뢰 저장소를 갱신합니다.

### 이미 있는 PostgreSQL을 쓰는 경우

빈 DB와 전용 로그인 역할을 준비합니다. 역할이 해당 DB에서 마이그레이션 스키마와 테이블을 생성할 수 있어야 합니다. 설치 서버에서 DB에 접근할 수 있게 설정하고, 백업과 복구용 PostgreSQL 16의 `pg_dump`와 `pg_restore`도 설치합니다. 아래는 HTTPS 프록시 방식의 예입니다.

```bash
read -r -s -p 'PostgreSQL 접속 URL: ' GEOMSUPIN_DATABASE_URL
printf '\n'
node scripts/onprem-setup.mjs --url https://review.example.com --bind 127.0.0.1 --port 3200 --services --database-url "$GEOMSUPIN_DATABASE_URL"
unset GEOMSUPIN_DATABASE_URL
```

접속 URL의 형태는 `postgresql://사용자:비밀번호@호스트:5432/데이터베이스`입니다. 도메인, 프록시, 내부 API 확인은 앞의 HTTPS 절차와 같습니다.

### 설치 옵션

| 옵션 | 사용 시점 |
| --- | --- |
| `--database-url <접속 주소>` | 이미 준비한 빈 PostgreSQL DB를 쓸 때. 전용 DB 서비스 생성을 건너뜁니다. |
| `--bind`, `--port` | 외부 공개 주소와 API 수신 주소·포트가 다를 때 |
| `--services` | systemd로 API와 백업 타이머를 운영할 때. 생략하면 설치 후 `npm start`로 직접 실행합니다. |
| `--issue-admin` | 설치 직후 기본 작업공간의 관리 링크도 함께 발급할 때 |
| `--rebuild` | 현재 소스로 정적 파일을 다시 빌드할 때 |
| `--force` | 기존 `.env`의 설정을 새 값으로 덮어쓸 때. `AUTH_SECRET`도 재생성되므로 기존 서명 파일 링크에 영향을 줍니다. |

## 관리자 접근과 주소 변경

API가 켜진 뒤 설치 계정으로 실행합니다. `--name`은 처음 만드는 작업공간의 이름입니다.

```sh
npm run manage -- --name "우리 팀"
```

출력된 `/#manage=…` 주소를 관리자 브라우저에 그대로 붙여 넣습니다. 링크는 15분 동안 한 번 쓸 수 있습니다. 관리 화면에서 **새 프로젝트 → 설정 → 검수할 사이트** 순서로 연결하고 **링크 복사**로 초대하세요. 팀원의 PC에서 초대를 열고, 검수핀을 북마크바에 끌어 놓은 뒤, 원래 사이트의 탭에서 눌러 **요청 남기기**로 첫 핀을 저장합니다. 관리 화면의 **요청**에 새 핀이 뜨는지 확인합니다. [화면으로 보는 사용법](../../docs/usage.md)

세션을 잃었거나 다른 PC에서 관리하려면 설치 폴더에서 `npm run manage`를 다시 실행합니다. 재발급하면 해당 작업공간의 이전 관리 링크와 기존 관리 세션은 만료됩니다. 작업공간이 여러 개라면 아래 명령을 사용합니다.

```bash
npm run manage -- --list
read -r -p '작업공간 ID: ' GEOMSUPIN_WORKSPACE_ID
npm run manage -- --workspace "$GEOMSUPIN_WORKSPACE_ID"
```

환경 설정 기준은 [환경 변수 예시](../../.env.example)입니다. 브라우저가 열 주소는 `PUBLIC_URL`, 허용 호스트는 `ALLOWED_HOSTS`, 수신 주소는 `HOST`와 `PORT`입니다. `DATABASE_URL`, `DATA_DIR`, 파일 서명에 쓰는 `AUTH_SECRET`은 설치마다 생성한 값을 사용합니다.

표준 경로 밖에 PostgreSQL 도구를 설치했다면 `.env`에도 `PG_BIN`을 기록해 백업 서비스에서 같은 경로를 사용하게 합니다. 복구 명령을 실행하는 셸에서도 `PG_BIN`을 내보냅니다.

주소 변경은 `npm run set-hosts -- https://review.example.com`으로 반영한 뒤 `systemctl --user restart geomsupin-api`로 적용합니다. 내부 포트도 바뀌면 `.env`와 프록시의 전달 포트를 함께 수정합니다. 검수할 사이트의 CSP와 내장 미리보기를 쓴 사이트의 연결 스크립트에 새 주소를 반영하세요. 관리 링크를 재발급하고 초대 링크를 다시 공유합니다. 참여자는 새 주소에서 북마크를 다시 저장합니다.

## 서비스 확인과 업데이트

```sh
systemctl --user status geomsupin-api geomsupin-backup.timer
journalctl --user -u geomsupin-api -n 50 --no-pager
curl --fail http://127.0.0.1:3200/healthz
```

`geomsupin-api`는 `active (running)`, 백업 타이머는 `active (waiting)`이면 정상입니다. 전용 DB는 `systemctl --user status geomsupin-db`, IP HTTPS 프록시는 `systemctl --user status geomsupin-tls`로 각각 확인합니다. 이후 참여자 PC에서도 공개 주소의 `/healthz`를 확인합니다.

사용자 서비스 없이 시험할 때는 설치 옵션에서 `--services`를 빼고 `npm start`로 서버를 실행합니다. 서버가 실행 중인 터미널은 둔 채 다른 터미널 또는 PC에서 `/healthz`를 확인하세요. 전용 DB가 꺼졌으면 설치 폴더에서 `npm run pg:start`로 먼저 시작합니다.

릴리스 배포를 쓸 경우 현재 체크아웃이 실제 운영 커밋인지 확인한 뒤 `npm run deploy -- --baseline "$(git rev-parse HEAD)"`를 한 번 실행합니다. 업데이트용 서버에는 테스트 DB, Chromium·Firefox와 PostgreSQL 도구가 필요합니다. [개발과 검증](../../README.md#개발과-검증)

```bash
git pull --ff-only
npm ci --include=dev
npm run services:install
npm run deploy -- --prepare
read -r -p '준비 명령이 출력한 릴리스 ID: ' GEOMSUPIN_RELEASE_ID
npm run deploy -- --activate "$GEOMSUPIN_RELEASE_ID"
```

현재 빌드 파일만 배포하려면 준비 단계에 `--current-assets-only`를 추가합니다. 이때 이전 화면을 열어 둔 사용자는 새로고침해야 할 수 있습니다.

외부 DB를 쓰는 설치에서는 서비스 정의를 갱신할 때 `npm run services:install -- --no-db`를 사용합니다. 준비 단계는 깨끗한 Git 커밋에서 별도 빌드·테스트를 실행합니다. 패키지와 브라우저가 캐시된 서버에서는 `--prepare --offline`을 쓸 수 있습니다. 반영 단계는 백업 후 API를 중지하고 검증된 릴리스로 전환한 뒤 상태와 정적 파일을 점검합니다.

되돌리려면 `npm run deploy -- --rollback <현재-릴리스-ID>`를 실행합니다. 코드 복귀로 DB 마이그레이션이 되돌아가지는 않습니다. 호환되지 않는 스키마 변경에서 복구하려면 아래 백업 복구 절차를 사용합니다. 실행 중인 릴리스는 `.local/current`, 배포 이력은 `.local/deploy-current.json`에서 확인합니다.

## 백업과 복구

통합 백업에는 DB 덤프, DB가 참조하는 캡처 원본·썸네일·위치 제안 이미지, 설치 설정이 들어갑니다. 백업 경로는 기본 `DATA_DIR/backups/`이며 `BACKUP_DIR`로 변경합니다. 비밀값이 포함되어 접근 권한이 필요합니다. `BACKUP_MIRROR_DIR`로 미리 마운트한 외부 저장소에 사본을 둘 수 있습니다. 로컬 보존 한도는 야간·수동·배포 전 각각 최근 14개입니다.

```bash
npm run backup
read -r -p '검증할 백업 폴더의 절대경로: ' GEOMSUPIN_BACKUP_PATH
npm run backup -- --verify "$GEOMSUPIN_BACKUP_PATH"
systemctl --user start geomsupin-backup.service
systemctl --user status geomsupin-backup.service
```

야간 타이머는 서버 시간 04:40부터 최대 2분 지연 후 실행합니다. 관리 화면에서 최근 실패, 장시간 진행 중단, 마지막 성공 뒤 36시간이 지난 상태를 확인할 수 있습니다. 서비스로 배포된 버전에서 즉시 수동 백업하려면 `node scripts/serve-release.mjs --backup`을 사용합니다.

복구용 **빈 DB**와 **빈 데이터 폴더**를 준비합니다. `RESTORE_DATABASE_URL` 환경변수에 복구할 DB의 접속 주소를 지정하고 아래 명령을 실행합니다.

```bash
read -r -s -p '복구 대상 PostgreSQL 접속 URL: ' RESTORE_DATABASE_URL
printf '\n'
export RESTORE_DATABASE_URL
read -r -p '백업 폴더의 절대경로: ' GEOMSUPIN_BACKUP_PATH
read -r -p '비어 있는 복구 데이터 폴더의 절대경로: ' GEOMSUPIN_RESTORE_PATH
npm run restore -- "$GEOMSUPIN_BACKUP_PATH" "$GEOMSUPIN_RESTORE_PATH"
unset RESTORE_DATABASE_URL
```

복구된 `recovered.env`에서 `DATABASE_URL`과 `DATA_DIR`을 새 위치에 맞춘 뒤 설치 폴더의 `.env`로 사용합니다. 기존 파일 링크를 유지하려면 원래 `AUTH_SECRET`이 필요합니다.

## 문제 해결

| 증상 | 확인할 것 |
| --- | --- |
| `421 Unknown host` | 주소창의 IP·도메인·포트와 `PUBLIC_URL`, `ALLOWED_HOSTS`, 프록시의 `Host` 전달 여부 |
| 서버에서만 열림 | API 바인딩과 방화벽, 참여자 PC에서 두 사이트에 접근 가능한지 |
| HTTPS 인증서 경고 | 주소가 인증서에 포함돼 있는지와 참여자 PC가 발급 CA를 신뢰하는지 |
| 요청에 `413`이 표시됨 | 프록시의 업로드 본문 한도와 캡처 크기 |
| 변경이 늦게 반영됨 | 프록시가 SSE 응답을 버퍼링하거나 캐시하는지 |
| 초대에 연결 안내가 표시됨 | 프로젝트 설정에 스테이징 주소를 저장했는지 |
| 미리보기 화면이 비어 있음 | 참여자 브라우저에서 원본을 새 탭으로 열어 도메인·인증서·사내망을 확인하고, 스테이징의 iframe 정책에서 검수핀 출처를 허용하는지 확인 |
| 사이트는 보이지만 핀을 남길 수 없음 | 원래 사이트 탭에서 프로젝트 북마크를 눌렀는지, 등록 주소와 사이트 출처가 일치하는지, CSP가 검수핀 스크립트와 API를 허용하는지 확인 |
| 특정 이미지가 캡처에서 빠짐 | 다른 출처의 리소스를 브라우저가 읽을 수 있는지. 이미지 프록시는 기본적으로 공개 HTTP(S) 이미지로 제한됩니다. |
| 초대 링크가 닫힘 | 검수 종료, 링크 폐기 또는 유효기간 만료 여부 |
| 관리 링크를 다시 쓸 수 없음 | 설치 서버에서 `npm run manage`로 새 링크 발급 |
| PostgreSQL 도구를 찾을 수 없음 | PostgreSQL 16 설치 및 `PG_BIN` 경로 |
