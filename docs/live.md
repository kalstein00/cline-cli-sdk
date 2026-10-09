# Windows → SSH → WSL 공개 CLI 실행

티켓 #3은 SDK 공개 API의 실제 연결·환경 점검·관리 실행·메시지·종료 상태와 로컬 웹 화면을 구현한다. 공개 Cline 3.0.69의 고정 Linux x64 실행 파일만 지원한다. 회사 fork는 미검증이며 질문·승인 응답, 재접속·재개는 후속 티켓 범위다.

```js
import { createClient } from '@cline-cli-sdk/sdk';
const client = createClient({
  mode: 'live',
  connection: {
    host: 'wsl', // OpenSSH 별칭, ProxyCommand, known_hosts, agent 그대로 사용
    cliPath: '/absolute/path/to/pinned/cline',
    remoteRoot: '/home/user/.local/state/cline-cli-sdk', // 선택, 0700
    // identityFile: 'C:/Users/user/.ssh/id_ed25519', // 선택, 내용 읽지 않음
  },
});
const report = await client.connect();
if (!report.ready) throw new Error(report.problems.join(', '));
client.subscribe(event => console.log(event));
await client.start({
  cwd: '/remote/workspace',
  prompt: 'Reply exactly SDK_LIVE_READY. Do not call any tools.',
  dataDir: '/remote/isolated-cline-data', // 선택, 인증은 사용자가 별도로 준비
});
console.log(await client.refresh());
client.close(); // 로컬 연결만 닫는다. 원격 작업을 중단하지 않는다.
```

`preflight()`는 작업을 시작하지 않고 Linux·Python 3.9 이상·PTY·tmux·CLI 실행 경로·버전·SHA-256·boot ID를 점검한다. 원격 helper는 사용자 권한으로 실행하며 tmux와 Python을 자동 설치하지 않는다. SSH는 Windows OpenSSH `ssh`를 args 배열로 실행하고 `BatchMode=yes`, `StrictHostKeyChecking=yes`를 강제한다. 비밀키·agent의 내용은 읽거나 JSON 응답/이벤트에 넣지 않는다.

CLI를 지정하지 않으면 비대화형 PATH를 먼저 조회하고, 없으면 제한 시간 안에 `bash -lic`에서 경로만 확인한다. login shell에서 찾은 CLI는 `noninteractive-path-mismatch`로 설명하고 명시 경로로 실행한다. 두 환경에 없으면 `cli-not-installed`, shell 조회 실패면 `cli-discovery-inconclusive`다. Python 부재는 `python-unavailable` prerequisite으로 보고한다.

지원 판정은 버전 `3.0.69`와 SHA-256 `8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032`의 조합이다. 같은 버전을 표시하는 다른 실행 파일도 `unknown` profile로 남기고 실행을 차단한다. 시작 직전에 해시를 재확인한다. 모든 모델 실행·버전 조회는 `CLINE_NO_AUTO_UPDATE=1`을 사용하며 전역 CLI·설정을 바꾸지 않는다.

SDK 제품 경로는 관찰 스크립트의 `--timeout 240`·`--retries 1`을 강제로 적용하지 않는다. CLI 자체 기본 제한을 사용한다. Node 수용 예제의 90초 대기는 관찰자의 확인 마감이며 원격 작업을 자동 중단하는 제한이 아니다.

원격 관리 디렉터리는 소유자 전용 0700이며 제어 파일·FIFO는 0600이다. tmux 전용 socket/session과 Python PTY supervisor가 GUI/SSH 수명과 CLI 수명을 분리한다. 실행 식별자는 UUID이고 Linux PID·`/proc/<pid>/stat`의 start time·boot ID를 함께 확인한다. CLI의 저장 JSON은 읽기 전용이며 제어 메타데이터와 CLI 데이터는 별도 디렉터리다. 초기 실행 argv는 시작 후 제어 파일에서 제거한다.

PTY 관측은 원격 512 KiB ring에서 cursor 이후 부분만 가져온다. 기록은 CLI의 현재 message JSON을 재조회하고 SHA-256이 바뀔 때만 같은 raw reducer에 공급한다. 부분 JSON은 마지막 정상 메시지를 보존한다. ring 누락은 `unknown` + 미지원 상호작용으로 나타내며 전체 화면 재동기화가 구현되기 전에는 입력을 허용하지 않는다. 평상시 SDK는 대화·원문을 로컬 파일에 저장하지 않는다. 원격 ring은 제한된 실행 관리용 버퍼이며 진단 아카이브가 아니다.

완료는 같은 실행의 프로세스 소멸·supervisor 종료 witness·CLI manifest `completed`·assistant 메시지를 함께 요구한다. exit 0만 있으면 성공으로 표시하지 않는다. `cancelled`는 stopped, 비정상 exit 또는 failed manifest는 failed, 과거 PID/boot·종료 witness 누락·원문 누락은 unknown으로 남긴다. SSH 조회 실패는 disconnected로 표시하고 마지막 정상 대화를 보존한다. 한 client는 한 관리 실행만 선택한다.

이 단계의 stopped는 CLI의 취소·종료 witness를 표시하는 상태 분류다. 실제 실행 중 자식 명령의 종료를 확인하는 작업 중단 API와 수용은 티켓 #8에서 제공한다. 시작 요청도 원격 전송 전에 실행 ID를 예약하므로 동시 클릭이나 전송 결과 불명 때 다른 실행을 자동으로 다시 만들지 않는다.

독립 Node 소비 예제:

```powershell
npm install
npm run build
$env:CLINE_SDK_HOST = 'wsl'
$env:CLINE_SDK_CLI_PATH = '/absolute/path/to/pinned/cline'
$env:CLINE_SDK_REMOTE_ROOT = '/home/user/isolated-test/control'
$env:CLINE_SDK_WORKSPACE = '/home/user/isolated-test/work'
$env:CLINE_SDK_DATA_DIR = '/home/user/isolated-test/data'
node examples/node/live.mjs
```

격리 인증은 SSH 원격 안에서만 사본을 준비한다. 예를 들어 기존 provider 파일의 정확한 위치를 확인한 뒤 `umask 077`, 전용 테스트 루트, `install -m 600 -- <확인한-source> <격리-data>/settings/providers.json`으로 복사한다. 내용을 터미널·Windows 로그·fixture로 출력하지 않는다. CLI 토큰 갱신은 원격 계정 상태에 영향을 줄 수 있다. 시험 후 해당 테스트 사본만 제거하고 원본과 대화 기록은 보존한다. SDK 제품이 자동으로 사용자 전역 인증/설정을 복사하지는 않는다.

웹 화면:

```powershell
$env:CLINE_SDK_PORT = '4174'
npm run example:web
```

`http://127.0.0.1:4174`에서 SSH 설정과 CLI 경로를 입력하여 연결·환경 점검 후 원격 디렉터리·요청으로 시작한다. 서버는 loopback만 바인딩하고 JSON mutation에 local Origin을 확인한다. 화면은 SDK 이벤트와 snapshot만 표시하며 CLI를 직접 파싱하지 않는다. 설정 응답에 identityFile·인증 설정을 되돌려주지 않는다.

## 2026-10-09 실제 근거

Windows → SSH 별칭 `wsl` → Ubuntu-24.04를 사용했다. SDK preflight 결과는 Linux, Python 3.12.3, tmux 3.4, PTY 가능, 고정 버전·해시 일치, ready true였다. 고정 실행 파일은 기존 관찰 루트 `cli-pinned/node_modules/@cline/cli-linux-x64/bin/cline`이며 격리 작업·데이터는 새 `cline-sdk-ticket3-20261009-7fa9` 루트에 준비했다. 전역 인증 내용을 출력하지 않고 원격끼리 필요한 provider 파일만 소유자 전용으로 복사했다.

- Node 공개 API 실측: execution `run-48b21ae6-08cd-46e9-ada8-992d78d57c4a`, session `1791541358131_a8a1g`. assistant `SDK_LIVE_READY`, 실제 프로세스 종료·exit 0·manifest completed로 완료했다.
- 최종 Node 재검증: helper source의 stdin 전송과 제품 경로의 관찰용 timeout/retry 제거 후 execution `run-d1b4027c-2c8d-49e6-8efe-8b4c721360cc`, session `1791542033090_25xmg`에서 같은 assistant 응답과 completed를 다시 확인했다.
- 브라우저 공개 API 실측: execution `run-bd1c2f47-55fd-4dad-b87f-cb249e07a061`, session `1791541594119_49juz`. 연결 점검·작업 시작 버튼을 사용했고 사용자 요청·assistant `SDK_LIVE_READY`·completed 표시가 실제 원격 기록과 일치했다. [화면 증거](evidence/ticket-3-completed.jpg).
- `fixtures/live-completion.json`은 첫 실제 SDK 실행의 PTY 수신 분할과 읽기 전용 history, 같은 boot의 프로세스 소멸 및 supervisor exit witness에서 만든 검토 fixture다. system prompt·환경 metadata를 제거하고 식별자를 치환했다. source 해시와 변환을 provenance에 기록했다. 이 초기 fixture에는 전체 자식 추적과 supervisor 종료 필드가 없어 현재 SDK는 메시지를 복원하되 execution unknown으로 표시한다. 정상 완료는 childrenVerified true·빈 children·supervisorAlive false·trackingError 없음까지 현재 증명해야 한다. 공개 회귀의 긍정 종료 증명은 별도 합성 fault 조건이며 이전 실제 기록을 수정해 증거를 보충하지 않는다.
- `npm test` 17/17은 공개 API에서 replay와 live 외부 OpenSSH boundary 대체를 검사한다. 새 live fixture를 같은 raw reducer에 공급해 메시지·완료를 검증하고, 실제 존재하지 않는 OpenSSH 실행 파일로 오류·stdin 정리 경로도 확인했다. 실제 WSL/브라우저 결과와 자동 fixture 결과를 서로 대체하지 않는다.

WSL SSH 별칭의 ProxyCommand는 WSL 배포판을 실행하므로 client-loss 시험 동안 배포판이 종료되지 않게 별도의 테스트 소유 keepalive가 필요하다. 이번 실측은 전용 `wsl.exe ... sleep 3600` 프로세스가 배포판을 유지하는 조건에서 수행했으며 작업 완료 후 해당 keepalive와 테스트 인증 사본만 정리했다. WSL 자체 종료·실행 중 질문 왕복·자식 명령 중단·재개·회사망 결과는 이 티켓의 성공으로 세지 않는다.

현재 선택·승인 응답은 [interactions.md](interactions.md), 자유 응답과 TUI 입력은 [text.md](text.md)를 따른다. 위 수용 기록은 #3 단계의 근거다.
