# 검수핀

한국어 · [English](README.md)

개발 중인 웹사이트에서 피그마처럼 원하는 위치에 의견을 남기는 팀용 검수 도구입니다. 디자이너가 로그인한 주문 화면의 버튼에 핀을 꽂으면 개발자는 그때의 캡처를 보고 같은 핀에서 답할 수 있습니다. 팀 서버에 설치하고 초대 링크를 공유하면 참여자는 평소 쓰는 PC 브라우저에서 검수합니다.

**1분 사용법 · 프로젝트 만들기부터 팀원의 핀에 답글 달기까지**

https://github.com/user-attachments/assets/b99c4dd8-4933-4783-b115-886f67be48b3

[한국어 MP4 다운로드](admin/public/tutorial/review-guide.mp4?raw=true) · [영어 영상](README.md) · [화면으로 보는 사용법](docs/usage.md)

**어떤 사이트에서 쓸 수 있나요?** 검수핀 스크립트와 서버 연결을 허용하는 스테이징에서 사용할 수 있습니다. HTTPS 사이트는 기본 3443 입구에서, HTTP 사이트는 선택 설치하는 3080 입구에서 검수합니다. 공개 사이트는 미리보기나 북마크 실행을 제한할 수 있습니다. [사이트별 사용 조건](docs/usage.md#사이트별-사용-조건)

## 1. 서버에 설치

팀원이 **`https://서버IP:3443`**에 접속하는 구성입니다. 참여자 PC에서 닿는 고정 IPv4 주소를 선택하고 참여자 네트워크에서 서버의 TCP `3443` 포트로 접속할 수 있게 하세요. Linux 서버에 Git, Node.js **22.12 이상**, npm, PostgreSQL **16**, nginx, OpenSSL이 필요합니다. 설치 계정에서 `systemctl --user`를 사용할 수 있어야 합니다. [Ubuntu 설치 준비](deploy/onprem/README.ko.md#설치-전-준비)

서버의 터미널에서 공개 저장소를 복제합니다.

```bash
git clone https://github.com/bumjopark/geomsupin.git
cd geomsupin
npm ci --include=dev
```

같은 Bash 터미널에서 서버의 IPv4 주소를 입력합니다. 설치기가 API·DB 서비스와 백업 타이머를 켜고, TLS 설정 도구가 nginx를 시작합니다. nginx는 `0.0.0.0:3443`에서 HTTPS 요청을 받아 내부 API `http://127.0.0.1:3200`으로 전달합니다. 예를 들어 서버 IP가 `192.168.1.50`이면 참여자가 열 주소는 `https://192.168.1.50:3443`입니다.

```bash
read -r -p '참여자 PC에서 접속할 서버 IPv4 주소: ' GEOMSUPIN_IP
npm run onprem:setup -- --url "https://${GEOMSUPIN_IP}:3443" --bind 127.0.0.1 --port 3200 --services &&
  node scripts/tls-setup.mjs --host "$GEOMSUPIN_IP" --port 3443 &&
  curl --fail --show-error --cacert .local/tls/ca.crt "https://${GEOMSUPIN_IP}:3443/healthz"
```

참여자에게는 공개 인증서 `.local/tls/ca.crt`를 신뢰할 수 있는 경로로 전달하세요. 각 PC에서 TLS 도구가 출력한 SHA-256 지문과 대조한 뒤 브라우저나 운영체제에 신뢰하는 인증기관으로 등록합니다. 참여자 PC에서 `https://서버IP:3443/healthz`를 열어 인증서 경고 없이 `{"ok":true}`가 보이면 준비됐습니다. 이 입구에서는 검수핀과 다른 출처의 HTTPS 사이트를 사용합니다. 도메인을 쓰려는 팀은 자체 DNS·인증서·프록시를 구성하세요. [인증서 등록과 운영 안내](deploy/onprem/README.ko.md#처음-설치)

HTTP 사이트를 검수하려면 [같은 IPv4 주소에 HTTP 입구를 추가하세요](deploy/onprem/README.ko.md#3080-포트에-http-입구-추가). 두 입구는 프로젝트·초대·관리 권한을 따로 운영합니다. HTTP에서는 초대 링크·댓글·캡처가 평문으로 전송되므로 신뢰할 수 있는 네트워크에서 테스트 데이터만 사용하세요.

## 2. 관리 링크 받기

설치 서버에서 검수핀 실행 계정으로 아래 명령을 실행합니다. 첫 설치에서는 조직 이름으로 작업공간을 만듭니다.

```sh
npm run manage -- --name "우리 팀"
```

출력된 링크를 관리자 브라우저에서 여세요. 15분 안에 한 번 사용할 수 있고, 교환이 끝나면 주소창에서 비밀값이 사라집니다. 관리 화면에서 프로젝트, 초대 링크, 저장된 요청을 관리합니다. 같은 작업공간의 관리 링크를 다시 발급하면 이전 링크와 관리 세션은 만료됩니다.

기존 설치를 업데이트하면 이전 프로젝트와 요청 기록이 이어집니다. 작업공간이 여러 개면 목록에서 관리할 곳을 고릅니다. 작업공간마다 관리 링크와 세션이 따로 발급됩니다.

```sh
npm run manage -- --list
read -r -p '작업공간 ID: ' GEOMSUPIN_WORKSPACE_ID
npm run manage -- --workspace "$GEOMSUPIN_WORKSPACE_ID"
```

## 3. 팀원 초대하기

1. **새 프로젝트**를 만들고 **설정 → 검수할 사이트**에 검수 대상 주소를 저장합니다.
2. **참여자 초대하기 → 링크 복사**를 눌러 팀원에게 보냅니다. 참여자는 받은 주소를 바로 열거나 공개 첫 화면의 **초대 링크**에 붙여넣고 **초대 열기**를 누릅니다.

## 4. 첫 핀 남기기

1. PC에서 초대 화면의 **검수핀 · 프로젝트명**을 브라우저 주소창 아래 북마크바로 끌어 놓습니다. 북마크바가 숨겨져 있으면 안내된 단축키를 누릅니다. 키보드만 쓸 때는 **드래그가 안 되나요?**를 엽니다.
2. 검수할 사이트를 일반 탭에서 열고 평소처럼 로그인합니다. 의견을 남길 페이지에서 저장한 북마크를 누릅니다.
3. **요청 남기기**를 누르고 화면에서 위치를 고릅니다. 별명과 내용을 입력합니다. 캡처를 확인하거나 **스크린샷 제외**를 선택한 뒤 **남기기**를 누릅니다.

관리자는 **요청**에서 캡처를 열어 보고 답글, 상태, 담당자를 관리할 수 있습니다. **엑셀로 받기**로 캡처가 포함된 요청 목록을 내려받습니다. [핀·대화·위치 변경 사용법](docs/usage.md)

같은 프로젝트의 참여자는 캡처와 페이지 제목·주소를 함께 볼 수 있습니다. 검수에는 테스트 데이터를 쓰고, URL에 민감한 값이 있는 화면은 피하세요. 대상 사이트가 외부 스크립트와 API 연결을 제한한다면 사이트 운영자의 설정이 필요합니다.

## 개발과 검증

위 설치 절차로 개발용 사본을 준비하세요. 전용 PostgreSQL 설치기는 테스트 DB도 만듭니다. 외부 DB를 쓴다면 검증 전에 별도 테스트 DB를 만들어 `.env`에 `TEST_DATABASE_URL`을 설정하세요. 테스트 DB 이름은 `*_test`로 끝나야 합니다.

```sh
npm ci --include=dev
npx playwright install chromium firefox
npm run check
```

시험은 테스트 DB의 스키마를 초기화하고 캡처를 임시 폴더에 저장합니다. `npm run check`는 타입 검사, 별도 폴더 빌드, Vitest, Playwright를 차례로 실행합니다. 기본 빌드 폴더는 `dist-test/`입니다. 브라우저 결과는 `test-results/report/`에 저장됩니다.

| 경로 | 역할 |
| --- | --- |
| `admin/` | React 관리 화면, 공개 초대와 사용법 영상 |
| `widget/` | 연결 스크립트, 핀·댓글·제안 UI, DOM 캡처 |
| `server/` | Fastify API, PostgreSQL, 검수 세션·실시간 알림, 파일·엑셀·백업 |
| `server/migrations/` | 번호순 스키마·데이터 마이그레이션 |
| `shared/` | 상태·요청 종류·입력·브라우저 공통 코드 |
| `demo/`, `tests/` | 별도 출처 스테이징, 단위·DB·브라우저 시나리오 |
| `scripts/` | 빌드·설치·관리 링크·검증·운영 도구 |

`npm run check`에는 다른 출처에서의 초대·캡처 가림·동시 편집·모달·실시간 복구와 관리 세션·업그레이드·백업 회귀가 포함됩니다. `PLAYWRIGHT_CHROMIUM_EXECUTABLE`로 Chromium 계열 실행 파일을 지정할 수 있고, `PLAYWRIGHT_EDGE_EXECUTABLE`을 설정하면 모달 검증에 Edge를 추가할 수 있습니다. 별도 `npm run test:spreadsheet`는 LibreOffice와 `python3-uno`로 파일 정렬·필터·재저장 후 캡처 링크를 확인합니다.

[구현 구조](docs/architecture.md)

## 운영

`npm run backup`은 DB, 참조하는 캡처 파일, 설정을 함께 보존합니다. `BACKUP_MIRROR_DIR`에 외부 저장소 사본을 둘 수 있습니다. 서비스 업데이트와 복구 절차는 [설치와 운영](deploy/onprem/README.ko.md)에 있습니다.

## 라이선스

검수핀 소스에는 MIT 라이선스를 적용합니다. 외부 패키지와 테스트 폰트는 각각의 원본 라이선스를 따릅니다. [MIT 라이선스 전문](LICENSE) · [테스트 폰트 고지](tests/fixtures/LICENSE.txt)
