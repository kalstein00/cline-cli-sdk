# Cline Chat 소비 앱

원격 Python 코드 전송 없이 설치된 CLI를 SSH/tmux로 실행하는 SDK 예제다. 첫 요청 실행, 읽기 전용 CLI 화면, 기존 JSON 대화 선택을 제공한다. 후속 입력·질문/승인 응답·재개·중단은 비활성화한다. [전체 제한 및 수동 상호작용 방법](../../docs/direct-ssh.md)을 먼저 확인한다.

## 저장소에서 실행

Node.js 22+에서 npm ci 후 npm run example:chat을 실행하고 http://127.0.0.1:4174 를 연다. CLINE_CHAT_PORT로 포트를 바꿀 수 있으며 서버는 127.0.0.1에만 바인딩한다.

설정은 SSH 별칭, 설치된 CLI 경로, 이미 존재하는 작업 폴더다. 대화 기록 폴더가 기본값과 다르면 sessionDirectory를 지정한다. 목록은 CLI 실행과 저장된 JSON 기록을 구분한다. 실행과 JSON은 수정 시각으로 자동 연결하지 않는다. 실행 생성 여부 불명에는 자동 재시작하지 않는다.

## 다른 프로젝트에서 독립 실행

SDK는 npm 공개 게시하지 않았습니다. 먼저 이 저장소에서 SDK를 빌드하고 패키지 파일을 만듭니다. 대상 디렉터리는 먼저 생성합니다.

```powershell
npm ci
npm run build
New-Item -ItemType Directory -Force C:\work\my-chat
npm pack ./packages/sdk --pack-destination C:\work\my-chat
```

빈 `C:\work\my-chat`에 `examples/chat`의 `package.json`, `server.mjs`, `index.html`, `app.mjs`, `style.css`, `README.md`를 복사합니다. 생성한 SDK `.tgz`도 이 디렉터리에 둡니다. 독립 프로젝트에서 다음을 실행합니다.

```powershell
cd C:\work\my-chat
npm install --save ./cline-cli-sdk-sdk-0.1.0.tgz
npm start
```

예제는 Node 내장 HTTP 서버와 SDK만 사용하며 Playwright·TypeScript·원래 저장소 소스·fixture·테스트 서버는 실행에 필요하지 않습니다. SDK 패키지에는 공개 타입과 로컬 배포 JS만 포함되며 원격 helper는 포함하지 않습니다. 예제의 SDK 의존성을 실제 `.tgz`로 바꾸는 `npm install --save` 단계가 필요합니다. workspace 연결을 사용하는 설치는 독립 설치 검증을 대신하지 않습니다.
