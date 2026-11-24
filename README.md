# 검수핀

한국어 · [English](README.en.md)

로그인한 사이트에서 고치고 싶은 곳을 클릭해 핀과 의견을 남기는 팀용 검수 도구입니다. 팀 서버에 설치하고 초대 링크를 공유하세요. 참여자는 평소 브라우저에 검수핀 북마크를 저장하면 됩니다.

**1분 사용법 · 프로젝트 만들기부터 팀원의 핀에 답글 달기까지**

https://github.com/user-attachments/assets/6994f722-b646-4e3c-9d6f-d8021c9805b6

[MP4 영상](admin/public/tutorial/review-guide.mp4?raw=true) · [한국어 자막](admin/public/tutorial/review-guide.ko.vtt?raw=true) · [영어 자막](admin/public/tutorial/review-guide.en.vtt?raw=true) · [설치와 운영](deploy/onprem/README.md) · [화면으로 보는 사용법](docs/usage.md)

설치한 검수핀에서는 상단 **사용법 영상**을 누르면 한국어 자막을 켜거나 원하는 장면으로 이동할 수 있습니다.

## 1. 서버에 설치

Linux 서버의 일반 사용자 계정에 Git, Node.js **22.12 이상**, npm, PostgreSQL **16**을 준비합니다. 서버에서 `systemctl --user`를 사용할 수 있어야 합니다. 도구 설치부터 필요한 포트까지 아래 문서에서 확인할 수 있습니다. [설치 준비](deploy/onprem/README.md#설치-전-준비)

GitHub의 **Code → HTTPS**에서 이 저장소 주소를 복사하고 서버의 Bash에서 실행합니다.

```bash
read -r -p 'GitHub에서 복사한 HTTPS 주소: ' GEOMSUPIN_REPO_URL
git clone "$GEOMSUPIN_REPO_URL" geomsupin && cd geomsupin
```

HTTPS 도메인과 리버스 프록시를 쓰는 예입니다. `review.example.com`을 실제 도메인으로 바꾸고 설치 폴더에서 실행합니다.

```sh
npm ci --include=dev
npm run onprem:setup -- --url https://review.example.com --bind 127.0.0.1 --port 3200 --services
curl --fail --show-error http://127.0.0.1:3200/healthz
```

프록시에서 원래 `Host`와 함께 요청을 `127.0.0.1:3200`으로 전달합니다. 그다음 참여자 PC에서 `https://review.example.com/healthz`를 열어 `{"ok":true}`를 확인하세요. 검수핀과 검수할 사이트는 모두 참여자 PC에서 열려야 하고, 같은 프로토콜을 쓰는 서로 다른 출처여야 합니다. 도메인 없이 IP로 HTTPS를 쓰거나 사내 HTTP로만 운영할 수 있습니다. [프록시 설정과 IP HTTPS 설치](deploy/onprem/README.md#처음-설치)

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
3. **요청 남기기**를 누르고 화면에서 위치를 고릅니다. 별명과 내용을 입력하고 **남기기**를 누릅니다.

관리자는 **요청**에서 캡처를 열어 보고 답글, 상태, 담당자를 관리할 수 있습니다. **엑셀로 받기**로 캡처가 포함된 요청 목록을 내려받습니다. [핀·대화·위치 변경 사용법](docs/usage.md)

## 개발과 검증

```sh
npm ci --include=dev
npx playwright install chromium firefox
npm run check
```

`.env`에 운영 DB와 다른 `TEST_DATABASE_URL`을 지정합니다. 테스트 DB 이름은 `*_test`로 끝나야 합니다. 시험은 전용 스키마를 초기화하고 캡처를 임시 폴더에 저장합니다. `npm run check`는 타입 검사, 별도 폴더 빌드, Vitest, Playwright를 차례로 실행합니다. 기본 빌드 폴더는 `dist-test/`입니다. 브라우저 결과는 `test-results/report/`에 저장됩니다.

| 경로 | 역할 |
| --- | --- |
| `admin/` | React 관리 화면, 공개 초대와 사용법 영상 |
| `widget/` | 연결 스크립트, 핀·댓글·제안 UI, DOM 캡처 |
| `server/` | Fastify API, PostgreSQL, 검수 세션·실시간 알림, 파일·엑셀·백업 |
| `server/migrations/` | 번호순 SQL 이력 |
| `shared/` | 상태·요청 종류·입력·브라우저 공통 코드 |
| `demo/`, `tests/` | 별도 출처 스테이징, 단위·DB·브라우저 시나리오 |
| `scripts/` | 빌드·설치·관리 링크·검증·운영 도구 |

`npm run check`에는 다른 출처에서의 초대·캡처 가림·동시 편집·모달·실시간 복구와 관리 세션·업그레이드·백업 회귀가 포함됩니다. `PLAYWRIGHT_CHROMIUM_EXECUTABLE`로 Chromium 계열 실행 파일을 지정할 수 있고, `PLAYWRIGHT_EDGE_EXECUTABLE`을 설정하면 모달 검증에 Edge를 추가할 수 있습니다. 별도 `npm run test:spreadsheet`는 LibreOffice와 `python3-uno`로 파일 정렬·필터·재저장 후 캡처 링크를 확인합니다.

[구현 구조](docs/architecture.md)

## 운영

`npm run backup`은 DB, 참조하는 캡처 파일, 설정을 함께 보존합니다. `BACKUP_MIRROR_DIR`에 외부 저장소 사본을 둘 수 있습니다. 서비스 업데이트와 복구 절차는 [설치와 운영](deploy/onprem/README.md)에 있습니다.

## 라이선스

검수핀 소스에는 MIT 라이선스를 적용합니다. 외부 패키지와 테스트 폰트는 각각의 원본 라이선스를 따릅니다. [MIT 라이선스 전문](LICENSE) · [테스트 폰트 고지](tests/fixtures/LICENSE.txt)
