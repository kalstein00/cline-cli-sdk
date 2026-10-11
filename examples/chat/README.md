# Cline Chat 소비 앱

Node 서버가 설치된 `@cline-cli-sdk/sdk` 공개 API를 호출하고 브라우저는 대화 목록·메시지·하단 입력창을 제공합니다. SDK는 원격 연동을 담당하고 소비 앱이 화면과 선택·초안 상태를 소유합니다. 이 예제에는 직접 SSH, CLI 파서 또는 임의 키 입력 endpoint가 없습니다.

## 이 저장소에서 실행

Node.js 22 이상에서 다음을 실행하고 [챗봇](http://127.0.0.1:4174)을 엽니다.

```powershell
npm ci
npm run example:chat
```

`CLINE_CHAT_PORT`로 포트를 변경합니다. 서버는 `127.0.0.1`에만 바인딩합니다. 기존 `npm run example:web`은 [SDK 테스트 GUI](http://127.0.0.1:4173)로, 연결·작업·진단·재생 기능을 개별 확인하는 화면입니다. 대화를 이어가는 소비 앱은 `example:chat`입니다.

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

예제는 Node 내장 HTTP 서버와 SDK만 사용하며 Playwright·TypeScript·원래 저장소 소스·fixture·테스트 서버는 실행에 필요하지 않습니다. SDK 패키지에는 공개 타입, 배포 JS와 SDK가 관리하는 원격 helper가 포함됩니다. 예제의 SDK 의존성을 실제 `.tgz`로 바꾸는 `npm install --save` 단계가 필요합니다. workspace 연결을 사용하는 설치는 독립 설치 검증을 대신하지 않습니다.

## 연결 준비와 사용

로컬 OpenSSH에서 접속 가능한 Linux 호스트를 준비합니다. SSH 별칭 또는 host, SSH agent 또는 키 파일을 사용할 수 있습니다. Linux에는 Python 3·tmux와 실행 가능한 Cline 및 CLI 인증이 준비되어야 합니다. SDK는 CLI 버전을 조회하거나 특정 버전으로 실행을 제한하지 않습니다. `--help`에서 기본 실행 옵션 `--cwd`, `--data-dir`, `--auto-approve`를 확인하며, 챗봇 실행에는 `--tui`, 재개에는 `--id`와 `--tui`가 필요합니다. JSON 출력과 retry 설정도 각각 실제 옵션을 확인합니다. 실행 파일 해시는 허용 목록이 아니라 같은 실행 파일·관리 작업을 확인하는 데 사용합니다. 회사 CLI의 실제 화면·기록 형식 호환성은 별도 검증해야 합니다. CLI 경로·관리 디렉터리·작업 디렉터리·격리 CLI 데이터 디렉터리는 원격 절대 경로입니다. 관리 디렉터리는 이 SDK의 시험/앱 소유 경로를 사용합니다. 데이터 디렉터리의 인증은 원격에서 준비하며 브라우저로 전달하지 않습니다.

설정을 입력하고 **연결 확인**의 preflight 결과를 확인합니다. **새 대화**의 첫 요청 뒤 SDK가 입력 준비를 확인하면 같은 실행에 후속 메시지를 보냅니다. 선택 질문과 승인은 대화 카드의 버튼을 사용합니다. 자유 응답 질문에서는 버튼이 **질문 응답 보내기**로 바뀝니다. 도구명과 전체 인자를 읽고 승인 또는 거절합니다.

**연결 준비 완료**는 SSH·실행 환경 확인이며 모델 인증 완료를 의미하지 않습니다. 기존 Cline 설정으로 대화하려면 **CLI 데이터 디렉터리**에 그 원격 경로를 지정합니다(이 개발 환경에서는 `/home/kalstein/.cline/data`). 비우면 매 실행의 새 격리 경로를 사용하며 SDK는 인증 설정을 자동 복사하지 않습니다. CLI가 provider 초기 설정 화면에서 대기하면 `Snapshot.startup.state='provider-setup-required'`와 안내를 표시합니다. 요청을 자동 재전송하지 않습니다. 현재 실행을 **작업 중단**으로 종료 확인한 뒤 새 대화에서 설정 경로를 지정합니다. 초기 설정 화면의 로그인이나 임의 키 입력은 챗봇으로 대신하지 않습니다.

목록은 관리 실행을 SID로 묶고 각 EID를 선택할 수 있게 합니다. 전환은 attach이며 원격 작업을 중단하지 않습니다. **연결 해제** 뒤 **재연결**하면 같은 실행을 복원합니다. 브라우저/Node 서버 재시작 뒤 **연결 확인**하면 저장된 마지막 EID를 목록에서 찾아 attach합니다. 제출 여부 불명은 **전달 상태 다시 확인**으로 ledger와 history를 재대조합니다. 자동 재전송하지 않으며 ledger가 불명이면 입력을 차단하고 마지막 정상 메시지를 유지합니다.

**작업 중단**은 별도 명시적 행동입니다. SDK가 CLI와 추적 자식 종료를 확인한 경우에만 **중단 확인**을 표시합니다. 종료 확인 대화에서는 **대화 재개하여 보내기**가 같은 SID의 새 EID로 이어집니다. 자동 stop→resume는 없습니다. 화면이나 로컬 서버 종료만으로 원격 작업이 중단되지는 않습니다.

## 입력 및 저장 계약

| 입력 용도 | 공개 API | 첫 버전 제한 |
| --- | --- | --- |
| 새 대화 첫 요청 | `start` | 비어 있지 않은 최대 100,000 JavaScript 문자. Enter 제출, Shift+Enter 여러 행 입력 |
| 살아 있는 대화 후속 요청 | `sendMessage` | printable 단일 행 UTF-8 **112바이트** |
| 종료 확인 대화 재개 | `resume` | printable 단일 행 UTF-8 **112바이트** |
| 현재 질문 자유 응답 | `respond` | printable 단일 행 UTF-8 **1,024바이트**, interaction이 text를 허용할 때만 |

후속/재개는 앞뒤 공백, 제어 문자, 불완전 surrogate, 선행 slash command, `@` mention과 64바이트를 넘는 grapheme을 지원하지 않습니다. 질문 응답도 원문 공백·제어 문자·grapheme 제한을 적용합니다. 한글과 emoji는 UTF-8 바이트로 계산하며 거부한 초안은 유지합니다. IME 조합 중 Enter는 제출하지 않습니다. 긴 일반 챗봇 메시지는 아직 지원하지 않습니다.

delivered는 CLI 수신 확인이며 답변 완료가 아닙니다. 새 user message ID와 예약한 history 경계로 후속 수신을 확인합니다. 같은 request ID를 다른 내용으로 재사용할 수 없으며 불명 전달을 새 ID로 우회할 수 없습니다. JSON 출력 모드는 양방향 입력 경로로 지원하지 않습니다. 지원 실측은 Windows→SSH→WSL의 고정 공개 Cline 3.0.69이며 회사 fork는 미검증입니다.

공개 CLI가 재개 후 session manifest에 이전 PID를 남기는 경우, 재개 요청 수신·답변을 확인해도 SDK가 이후 후속 입력을 차단합니다. 현재 실행의 작업 단계 근거가 부족하기 때문입니다. 모든 재개 실행에서 바로 다음 후속 입력까지 가능한 것으로 간주하지 않습니다.

localStorage에는 host/CLI/관리/작업/데이터 경로와 마지막 관리 EID만 저장합니다. 키 파일 경로·키 내용·대화·초안·원시 출력은 기본 영구 저장하지 않습니다. 초안은 현재 브라우저 메모리에만 대화별로 유지됩니다. `CLINE_CHAT_DIAGNOSTICS`를 지정하면 SDK opt-in 진단을 그 로컬 디렉터리에 수집합니다. 대화·도구 입력·터미널 내용이 포함될 수 있으므로 공유 전에 검토합니다. 기본은 비활성이며 외부 자동 반출은 없습니다.

## 다른 화면에 적용하는 공개 API 경계

`server.mjs`는 `createClient`의 `connect`, `subscribe`, `snapshot`, `refresh`, `capabilities`, `start`, `sendMessage`, `respond`, `listManagedExecutions`, `attach`, `reconfirmDelivery`, `resume`, `stop`, `disconnect`, `close`를 사용합니다. 자신의 Node 계층에서 공개 export를 import하고 제품 UI는 자신의 화면으로 구현합니다.

```js
import {createClient} from '@cline-cli-sdk/sdk';
const client = createClient({mode:'live', connection:{host:'my-linux', cliPath:'/opt/cline/bin/cline', remoteRoot:'/home/me/my-chat/control'}});
const preflight = await client.connect();
if (!preflight.ready) throw Error(preflight.problems.join(', '));
const unsubscribe = client.subscribe(() => renderYourApp(client.snapshot(), client.capabilities()));
await client.start({cwd:'/home/me/work', dataDir:'/home/me/my-chat/data', prompt:'Reply hello.', terminalMode:'tui'});
// 별도 refresh 루프로 상태를 읽고, 준비 확인 후 사용자 요청에만 전송합니다.
const s = client.snapshot();
if (client.capabilities().sendMessage && s.messageInput?.ready) {
  await client.sendMessage({sessionId:s.sessionId, executionId:s.executionId, revision:s.revision, requestId:crypto.randomUUID(), text:'Reply again.'});
}
// 화면 종료 시 unsubscribe(); client.close(); — 원격 stop과는 별개입니다.
```

브라우저 계약은 `GET /api/state`, SSE `GET /api/events`와 JSON POST입니다. 상태는 `serverId`, 선택 `generation`, `selectedId`, `executions`, 공개 `snapshot/capabilities`, `preflight`, `busy`, `launchReserved`입니다. 모든 POST에 현재 `serverId/generation/requestId`를 함께 보내며 서버가 중복·선택을 검증합니다. 현재 snapshot revision도 message/respond 입력 대상에 결합합니다.

| POST | 추가 필드/역할 |
| --- | --- |
| `/api/connect` | `host,cliPath,remoteRoot,identityFile?`, 복원할 `executionId?` |
| `/api/new`, `/api/list` | 새 선택 / 관리 목록 갱신 |
| `/api/select` | `executionId`로 새 클라이언트 attach |
| `/api/start` | `cwd,dataDir?,prompt` |
| `/api/message` | `sessionId,executionId,revision,text` |
| `/api/respond` | `sessionId,executionId,interactionId,revision,answer` |
| `/api/resume` | `sessionId,executionId,text` |
| `/api/stop` | `sessionId,executionId` |
| `/api/disconnect`, `/api/reconnect`, `/api/reconfirm` | 연결 유지/복구 및 읽기 전용 전달 재대조 |

브라우저는 message ID로 갱신하고 이전 serverId/generation 결과를 무시합니다. pending ID를 유지하고 HTTP 오류만으로 미제출을 단정하지 않습니다. capabilities/history/inputControl과 현재 질문을 함께 확인합니다. 서버는 loopback Host/Origin과 JSON 형식·본문 크기를 검사합니다. 로컬 단일 소비 앱용이며 공개 웹 서비스나 여러 앱 동시 제어 계약은 아닙니다.

실제 브라우저·공개 CLI 근거와 fixture/장애 주입 결과는 저장소의 `docs/chat-acceptance.md`에 구분해 기록했습니다.
