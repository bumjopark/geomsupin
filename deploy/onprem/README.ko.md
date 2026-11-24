# 설치와 운영

한국어 · [English](README.md)

검수핀 설치 서버에서 작업합니다. 참여자가 쓰는 브라우저에는 검수핀 북마크를 저장합니다. [한국어 README](../../README.ko.md) · [English README](../../README.md) · [화면으로 보는 사용법](../../docs/usage.md)

## 설치 전 준비

일반 Linux 계정으로 서버에 접속합니다. 이 계정은 Git 복제 폴더, `.env`, `data/`, `.local/`과 사용자 systemd 설정에 쓸 수 있어야 합니다. OS 패키지 설치에는 관리자 권한을 사용하세요. 소스 복제, npm, PostgreSQL 클러스터 초기화, 검수핀과 HTTPS 서비스는 일반 계정으로 실행합니다. 처음 설치할 때는 이 계정에서 GitHub와 npm 레지스트리에 접속할 수 있어야 합니다.

Ubuntu 24.04 예시입니다. 다른 배포판에서는 PostgreSQL **16** 서버·클라이언트 패키지를 준비합니다. 기본 실행 파일 경로는 `/usr/lib/postgresql/16/bin`입니다. 다른 경로를 쓰면 설치 전에 `PG_BIN`을 그 디렉터리로 설정합니다. Node.js **22.12 이상**과 npm이 없다면 공식 다운로드에서 Linux용 패키지를 선택하세요. [PostgreSQL Linux 패키지](https://www.postgresql.org/download/) · [Node.js 공식 다운로드](https://nodejs.org/en/download)

```bash
sudo apt update
sudo apt install git curl ca-certificates xz-utils postgresql-16 postgresql-client-16 nginx openssl
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
"${PG_BIN:-/usr/lib/postgresql/16/bin}/postgres" --version
systemctl --user show-environment >/dev/null
```

마지막 명령에서 사용자 버스에 연결할 수 없다면 서버의 systemd 로그인 세션으로 설치 계정에 직접 접속해 다시 확인합니다. 로그아웃이나 재부팅 뒤에도 사용자 서비스를 유지하려면 설치 계정에서 `sudo loginctl enable-linger "$(id -un)"`을 실행합니다. 권한이 없는 경우 서버 관리자에게 해당 계정의 linger 활성화를 요청하세요.

공개 저장소를 복제합니다. 이후 명령은 `package.json`이 있는 복제 폴더에서 실행합니다.

```bash
git clone https://github.com/bumjopark/geomsupin.git && cd geomsupin
npm ci --include=dev
```

검수핀의 기본 설치는 팀 PC에서 접속할 수 있는 고정 서버 IPv4 주소를 사용합니다. 고정 IP 또는 DHCP 예약을 준비하세요. 방화벽에서 검수할 팀 네트워크에만 서버의 `3443/tcp`를 허용합니다. 사용자 nginx는 `0.0.0.0:3443`에서 HTTPS를 받고 API의 `127.0.0.1:3200`으로 전달합니다. API 포트와 전용 DB 포트 `55433`은 루프백에서만 사용합니다.

3443 입구에서는 검수핀과 다른 출처의 HTTPS 사이트를 사용합니다. HTTP 사이트는 아래의 별도 HTTP 입구에 원래 주소를 등록합니다. 참여자 PC에서 검수핀과 검수할 사이트가 모두 열리는지 확인하세요. 초대 전에 대상 사이트의 스크립트·연결·iframe 정책도 확인하세요. [사이트별 사용 조건](../../docs/usage.md#사이트별-사용-조건)

## 처음 설치

### 서버 IP로 HTTPS 설치

팀 PC에서 사용할 서버의 고정 IPv4를 입력하세요. 첫 명령은 API, 전용 PostgreSQL과 백업 타이머를 사용자 서비스로 설치합니다. TLS 명령은 인증서를 발급하고 사용자 nginx 서비스를 시작합니다.

```bash
read -r -p '팀 PC에서 접속할 서버 IPv4 주소: ' GEOMSUPIN_IP
npm run onprem:setup -- --url "https://${GEOMSUPIN_IP}:3443" --bind 127.0.0.1 --port 3200 --services &&
  node scripts/tls-setup.mjs --host "$GEOMSUPIN_IP" --port 3443
```

첫 실행에서는 DB 마이그레이션이 끝나고 API가 정상 응답할 때까지 설치기가 최대 3분간 기다립니다. 설치 계정에서 서비스와 HTTPS 연결을 확인합니다. `/healthz`가 `{"ok":true}`를 반환하면 HTTPS 프록시를 거쳐 API와 DB까지 연결된 상태입니다.

```bash
systemctl --user status --no-pager geomsupin-api geomsupin-db geomsupin-tls geomsupin-backup.timer
curl --fail --show-error --cacert .local/tls/ca.crt "https://${GEOMSUPIN_IP}:3443/healthz"
```

### 팀 PC에서 사내 CA 신뢰하기

1. 서버의 `.local/tls/ca.crt` **공개 CA 인증서만** 승인된 사내 전달 경로로 배포합니다. 별도의 신뢰할 수 있는 경로로 TLS 스크립트가 출력한 SHA-256 지문을 전달하고 설치 전에 대조하세요. `ca.key`와 `gp.key`는 서버에 보관합니다.
2. 각 PC에서 조직의 인증서 배포 절차를 따릅니다. **Windows**는 현재 사용자의 **신뢰할 수 있는 루트 인증 기관**, **macOS**는 키체인 접근, **Linux**는 배포판과 브라우저가 사용하는 신뢰 저장소를 확인하세요.
3. 실제 검수에 사용할 브라우저를 다시 열어 `https://서버-IP:3443/healthz`에 접속합니다. 인증서 경고 없이 `{"ok":true}`가 나와야 합니다. 검수할 사이트도 같은 브라우저에서 인증서 경고 없이 열리는지 확인하세요.

설치한 HTTPS 서버에서도 `/gp-ca.crt`로 공개 인증서를 제공합니다. 아직 신뢰를 설정하지 않은 PC에는 승인된 사내 경로로 먼저 배포하세요. 서버 인증서가 만료되기 전에 현재 IP와 TLS 디렉터리를 사용한 명령에 `--renew`를 붙여 갱신합니다.

### 3080 포트에 HTTP 입구 추가

HTTPS 사이트용 3443은 유지하고 HTTP 사이트용 검수핀을 별도 복제본에 설치합니다. 두 입구는 같은 IPv4 주소를 씁니다. 서버에 할당된 공인 IP 또는 참여자가 접속할 수 있는 사내 IP를 쓰고 TCP 3080 포트로 들어올 수 있게 하세요. 검수할 사이트는 기존 HTTP 주소를 그대로 사용합니다.

HTTPS 설치 폴더에서 위와 같은 `GEOMSUPIN_IP` 값으로 다음 Bash 명령을 실행합니다. 괄호 안의 명령이 끝나면 원래 HTTPS 설치 폴더에 남습니다.

```sh
(
  cd .. &&
  git clone https://github.com/bumjopark/geomsupin.git geomsupin-http &&
  cd geomsupin-http &&
  npm ci --include=dev &&
  npm run onprem:setup -- --instance http --url "http://${GEOMSUPIN_IP}:3080" --bind "$GEOMSUPIN_IP" --port 3080 --peer-url "https://${GEOMSUPIN_IP}:3443" --services
)
```

HTTP 복제본은 자체 `.env`, `AUTH_SECRET`, 데이터와 백업을 사용합니다. 전용 DB는 루프백 55434 포트에서 실행합니다. 두 설치의 DB와 비밀값을 따로 유지하세요. HTTP 서비스 이름은 `geomsupin-http-`로 시작합니다.

HTTPS 설치의 `.env`에 `PEER_REVIEW_URL=http://서버-IP:3080`을 추가하거나 갱신합니다. HTTP 설치에 사용한 같은 IPv4 주소를 넣고 다음 명령으로 확인하세요.

```sh
systemctl --user restart geomsupin-api
systemctl --user status geomsupin-http-api geomsupin-http-db geomsupin-http-backup.timer
curl --fail --show-error "http://${GEOMSUPIN_IP}:3080/healthz"
curl --fail --show-error --cacert .local/tls/ca.crt "https://${GEOMSUPIN_IP}:3443/healthz"
```

각 입구는 현재 접속 방식과 상대 입구의 첫 화면으로 이동할 링크를 보여 줍니다. 링크에는 초대나 관리 정보가 없으며 자동으로 이동하지 않습니다. HTTP 복제 폴더에서 `npm run manage -- --name "우리 HTTP 검수 팀"`을 실행해 첫 관리 링크를 발급하세요. 그 입구에서 프로젝트를 만들고 초대 링크를 발급합니다. 두 입구의 프로젝트·초대·관리 권한은 별도입니다.

**HTTP에서는 초대 링크·댓글·캡처가 평문으로 전송됩니다.** 신뢰할 수 있는 네트워크에서 테스트 데이터만 사용하세요. 민감한 검수는 HTTPS 입구를 사용하세요.

### 외부 PostgreSQL 사용

기본 설치 대신 아래 명령을 실행합니다. 빈 DB와 마이그레이션 스키마·테이블을 만들 수 있는 전용 로그인 역할을 준비하세요. 설치 계정에서 DB에 접속할 수 있어야 하며, 설치 서버에 백업·복구용 PostgreSQL 16의 `pg_dump`와 `pg_restore`도 필요합니다.

```bash
read -r -p '팀 PC에서 접속할 서버 IPv4 주소: ' GEOMSUPIN_IP
read -r -s -p 'PostgreSQL 접속 URL: ' GEOMSUPIN_DATABASE_URL
printf '\n'
node scripts/onprem-setup.mjs --url "https://${GEOMSUPIN_IP}:3443" --bind 127.0.0.1 --port 3200 --services --database-url "$GEOMSUPIN_DATABASE_URL" &&
  node scripts/tls-setup.mjs --host "$GEOMSUPIN_IP" --port 3443
unset GEOMSUPIN_DATABASE_URL
```

접속 URL의 형태는 `postgresql://사용자:비밀번호@호스트:5432/데이터베이스`입니다. 전용 `geomsupin-db` 서비스는 생성되지 않습니다. API·TLS·백업 타이머와 HTTPS 상태를 확인하고 팀 PC의 CA 신뢰를 위와 같이 설정합니다.

### 팀이 관리하는 도메인과 외부 프록시

팀에 DNS, 신뢰되는 공개 CA 인증서와 HTTPS 프록시가 이미 있다면 설치의 `--url`에 실제 도메인 주소를 사용합니다. 팀 프록시가 내부 API로 요청을 전달하며 원래 `Host`를 보존하도록 구성하세요. 실시간 알림을 위한 SSE 응답은 버퍼링·캐싱을 끄고, 캡처 업로드 용량을 허용하며, 초대 주소를 접근 로그에서 제외합니다. 이 구성에서는 팀 프록시가 TLS를 처리합니다.

### 설치 옵션

| 옵션 | 사용 시점 |
| --- | --- |
| `--database-url <접속 주소>` | 이미 준비한 빈 PostgreSQL DB를 쓸 때. 전용 DB 서비스 생성을 건너뜁니다. |
| `--bind`, `--port` | 외부 공개 주소와 API 수신 주소·포트가 다를 때 |
| `--instance http`, `--pg-port 포트` | 별도 HTTP 복제본을 설치할 때. 전용 루프백 DB의 기본 포트는 55434입니다. |
| `--peer-url 주소` | 반대 프로토콜을 사용하는 검수핀의 첫 화면을 연결할 때 |
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

서버 IP가 바뀌면 이전 CA의 허용 범위가 새 IP와 맞지 않습니다. 새 IP 전용 TLS 디렉터리에서 인증서를 만든 뒤 공개 주소를 바꾸고 API를 다시 시작합니다.

```bash
read -r -p '새 서버 IPv4 주소: ' GEOMSUPIN_NEW_IP
node scripts/tls-setup.mjs --host "$GEOMSUPIN_NEW_IP" --port 3443 --dir ".local/tls-${GEOMSUPIN_NEW_IP}" &&
  npm run set-hosts -- "https://${GEOMSUPIN_NEW_IP}:3443" &&
  systemctl --user restart geomsupin-api
```

새 TLS 디렉터리의 공개 CA 인증서를 배포하고, 팀 PC의 실제 브라우저에서 새 HTTPS 주소를 확인합니다. 새 IP에서 `3443/tcp`가 검수 팀에 열려 있는지 확인하고 검수할 사이트의 CSP와 사용하는 연결 스크립트를 갱신합니다. 관리 링크를 재발급하고 초대 링크를 다시 공유하세요. 참여자는 새 초대 주소에서 북마크를 다시 저장합니다. 내부 API 포트도 바뀐다면 `.env`의 `PORT`와 TLS 프록시 대상 포트를 함께 갱신합니다.

## 서비스 확인과 업데이트

```sh
systemctl --user status geomsupin-api geomsupin-backup.timer
journalctl --user -u geomsupin-api -n 50 --no-pager
curl --fail http://127.0.0.1:3200/healthz
```

`geomsupin-api`는 `active (running)`, 백업 타이머는 `active (waiting)`이면 정상입니다. 전용 DB는 `systemctl --user status geomsupin-db`, IP HTTPS 프록시는 `systemctl --user status geomsupin-tls`로 각각 확인합니다. 이후 참여자 PC에서도 공개 주소의 `/healthz`를 확인합니다.

사용자 서비스 없이 시험할 때는 설치 옵션에서 `--services`를 빼고 `npm start`로 서버를 실행합니다. 서버가 실행 중인 터미널은 둔 채 다른 터미널 또는 PC에서 `/healthz`를 확인하세요. 전용 DB가 꺼졌으면 설치 폴더에서 `npm run pg:start`로 먼저 시작합니다.

릴리스 배포를 처음 쓸 때는 업데이트를 내려받기 전에 현재 체크아웃이 실제 운영 커밋인지 확인한 뒤 `npm run deploy -- --baseline "$(git rev-parse HEAD)"`를 한 번 실행합니다. 업데이트용 서버에는 테스트 DB, Chromium·Firefox와 PostgreSQL 도구가 필요합니다. [개발과 검증](../../README.ko.md#개발과-검증)

```bash
git pull --ff-only
npm ci --include=dev
```

업데이트한 뒤 서비스 정의를 갱신합니다. 설치기는 전용·외부 DB 선택과 설치 때 지정한 `PG_BIN`을 저장합니다. 이전 버전에서 외부 DB를 쓰면서 `data/postgres/`에 과거 전용 클러스터까지 남겨 둔 경우에는 `npm run services:install -- --no-db`를 명시하세요.

```sh
npm run services:install
```

```bash
npm run deploy -- --prepare
read -r -p '준비 명령이 출력한 릴리스 ID: ' GEOMSUPIN_RELEASE_ID
npm run deploy -- --activate "$GEOMSUPIN_RELEASE_ID"
```

이전 릴리스의 정적 파일을 함께 유지하지 않으려면 준비 단계에 `--current-assets-only`를 추가합니다. 이때 이전 화면을 열어 둔 사용자는 새로고침해야 할 수 있습니다.

준비 단계는 깨끗한 Git 커밋에서 별도 빌드·테스트를 실행합니다. 패키지와 브라우저가 캐시된 서버에서는 `--prepare --offline`을 쓸 수 있습니다. 반영 단계는 백업 후 API를 중지하고 검증된 릴리스로 전환한 뒤 상태와 정적 파일을 점검합니다.

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
| 사이트는 보이지만 핀을 남길 수 없음 | 원래 사이트 탭에서 프로젝트 북마크를 눌렀는지, 등록 주소와 사이트 출처가 일치하는지, 스테이징의 스크립트·API·Trusted Types 정책이 위젯 실행을 허용하는지 확인 |
| 공개 스테이징에서는 사내 검수핀을 연결할 수 없음 | Chrome에서 공개 출처가 사내 주소로 접속하는 데 필요한 로컬 네트워크 권한과 조직의 브라우저 정책을 확인합니다. [Chrome 로컬 네트워크 접근](https://developer.chrome.com/blog/local-network-access) |
| 특정 이미지가 캡처에서 빠짐 | 다른 출처의 리소스를 브라우저가 읽을 수 있는지. 이미지 프록시는 기본적으로 공개 HTTP(S) 이미지로 제한됩니다. |
| 초대 링크가 닫힘 | 검수 종료, 링크 폐기 또는 유효기간 만료 여부 |
| 관리 링크를 다시 쓸 수 없음 | 설치 서버에서 `npm run manage`로 새 링크 발급 |
| PostgreSQL 도구를 찾을 수 없음 | PostgreSQL 16 설치 및 `PG_BIN` 경로 |
