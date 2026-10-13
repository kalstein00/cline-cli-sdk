# Windows → SSH → WSL 공개 CLI 실행

## 현재 설치 CLI의 기존 저장 방식

`connection.storageMode: 'native'`는 기존 인증·설정·대화 기록을 사용하며 `--data-dir`을 요구하거나 전달하지 않는다. 현재 `ssh wsl`의 실제 관측·공개 API·브라우저 재현 절차는 [기본 저장 지원 계약](observations/wsl-native-storage.md)을 따른다. `cwd`는 기존 작업 디렉터리이며 경로 오류는 실행 전 원인별로 반환한다. `help.state`와 `missingOptions`로 도움말 실패와 확인된 옵션 누락을 구분한다. 회사 fork는 미검증이다.

아래 내용은 기존 격리 실행과 #3 당시 수용 기록이다.

티켓 #3은 SDK 공개 API의 실제 연결·환경 점검·관리 실행·메시지·종료 상태와 로컬 웹 화면을 구현한다. 현재 SDK는 CLI 버전 조회나 특정 버전·해시 허용 목록을 사용하지 않는다. 기존 실제 실행 근거는 공개 Cline 3.0.69 Linux x64 기준이다. 회사 fork는 미검증이며 질문·승인 응답, 재접속·재개는 후속 티켓 범위다.

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

`preflight()`는 작업을 시작하지 않고 Linux·Python 3.9 이상·PTY·tmux·CLI 실행 경로·필수 옵션·SHA-256·boot ID를 점검한다. 원격 helper는 사용자 권한으로 실행하며 tmux와 Python을 자동 설치하지 않는다. SSH는 Windows OpenSSH `ssh`를 args 배열로 실행하고 `BatchMode=yes`, `StrictHostKeyChecking=yes`를 강제한다. 비밀키·agent의 내용은 읽거나 JSON 응답/이벤트에 넣지 않는다.

CLI를 지정하지 않으면 비대화형 PATH를 먼저 조회하고, 없으면 제한 시간 안에 `bash -lic`에서 경로만 확인한다. login shell에서 찾은 CLI는 `noninteractive-path-mismatch`로 설명하고 명시 경로로 실행한다. 두 환경에 없으면 `cli-not-installed`, shell 조회 실패면 `cli-discovery-inconclusive`다. Python 부재는 `python-unavailable` prerequisite으로 보고한다.

preflight는 CLI 버전을 조회하지 않으며 `cliVersion`은 `null`이다. 실행 가능한 파일과 도움말의 `--cwd`, `--data-dir`, `--auto-approve`를 확인한다. TUI·JSON·retry는 각각 `--tui`, `--json`, `--retries`를 추가 확인하며 재개는 `--id`와 `--tui`를 함께 확인한다. 시작 직전에 같은 실행 파일인지 해시를 재확인한다. 모델 실행·도움말 조회는 `CLINE_NO_AUTO_UPDATE=1`을 사용하며 전역 CLI·설정을 바꾸지 않는다. 회사 CLI의 화면·기록 형식은 실제 시험으로 확인해야 한다.

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

## 커스터마이징된 CLI의 composer 인식

후속 메시지의 composer는 현재 커서 행의 `❯ `와 바로 위·아래의 `─` 구분선(20자 이상)으로 확인한다. 화면 하단으로부터의 행 번호, 탐색 범위, 상태줄 개수·문구에는 의존하지 않는다. witness는 입력창 구조·실제 화면 크기·커서 위치를 묶으며 상태줄 갱신은 witness를 바꾸지 않는다. 빈 입력 확인과 재개 후 대기 상태 확인도 관측된 커서 행을 사용한다. 모달·프로세스·history·입력 원장 검증은 유지한다.

120×40은 생략 시 기본값이며 고정 지원 조건이 아니다. `client.start({cwd, prompt, terminalMode:'tui', terminal:{cols:80, rows:24}})`처럼 시작 크기를 지정할 수 있다. 기존 기록 검증과 같은 20~500열·5~200행 범위를 유지한다. 실행 중 tmux pane 크기가 바뀌면 supervisor가 내부 CLI PTY에 크기를 전달하고, SDK는 해당 크기의 전체 화면을 다시 확인한 뒤 입력을 허용한다. 화면 확인 실패나 캡처 도중 크기·커서 변경은 입력을 차단하며, 이전 크기의 witness로 쓰기를 진행하지 않는다. 재개 실행은 이전 실행에 저장된 크기를 상속한다.

크기 변경 후 화면을 확인하기 전에 CLI가 종료되더라도, 이력과 CLI·supervisor·자식 프로세스의 종료가 모두 확인되면 완료·중단 상태를 유지한다. 종료된 실행의 입력을 활성화하지 않으며, 저장된 새 크기는 재개 프롬프트 길이 제한에만 사용한다. 종료 근거가 불충분한 경우에는 계속 차단한다.

질문·승인 modal witness는 제목부터 화면 끝까지 모든 행을 포함한다. 마지막 몇 행을 상태줄로 가정해 제외하지 않으므로, 작은 화면 하단의 선택지·입력 내용 변경도 기존 응답 검증을 무효화한다. 상태줄만 변경되어도 보수적으로 새 관측을 요구한다. 입력 예약에는 아직 payload가 없으며, 너비 검사는 실제 payload가 있는 쓰기 단계에서 수행한다.

후속 메시지와 재개 프롬프트는 한 줄 입력이므로 UTF-8 바이트 한도를 `min(112, cols-8)`로 제한한다. 예를 들어 80열은 72바이트다. UTF-8 바이트 수로 표시 너비를 보수적으로 제한하고 프롬프트와 우측 여백을 남긴다. 소비 앱은 `snapshot.messageInput.maxBytes`를 사용한다. SDK는 새 관측 후 길이를 다시 검사하고, 원격 supervisor도 각 쓰기 직전에 남은 너비를 검사한다. 이전 버전으로 이미 시작한 supervisor는 실행 중 교체되지 않으므로 새 버전으로 시작한 실행에서 검증한다.

`fixtures/chat/company-composer-layout.json`은 회사 보고의 배치를 재현한 합성 자료이며 VDI 원본 캡처가 아니다. `node --test tests/message-input.test.mjs tests/send-message.test.mjs tests/resume.test.mjs`는 빌드 후 공개 API의 위치 변화·구조 손상·모달 차단·연속 후속 메시지·공개 CLI 기록을 검사한다. `python3 tests/composer-witness.py`는 실제 supervisor 함수 정의에 통제된 tmux/process IO를 제공하여 커서 행·witness·빈 입력 검사를 검증하며 Linux나 tmux 설치가 필요 없다. 실제 회사 CLI 호환성 및 VDI 후속 메시지 전송은 별도 실측이 필요하다.

## Nullable 응답 프레임 회귀

일반 TUI 선택은 inputType을 생략한다. helper가 FIFO 프레임에 이를 JSON null로 기록하므로 소비 supervisor는 null도 일반 modal witness로 검사해야 한다. composer- 문자열에만 composer witness를 선택한다. null에서 startswith를 호출해 supervisor가 종료되던 문제는 문자열 여부 검사로 수정했다. 입력의 세션·프로세스·history·modal binding과 원장/중복 정책은 그대로 적용한다.

Linux에서 `python3 tests/remote-input-boundary.py`를 실행한다(Python 3.9+, tmux, pidfd 필요). 시험은 임시 전용 tmux socket, 통제 Python CLI, 실제 helper stdin→FIFO→PTY 소비를 사용하며 모델·인증·회사 CLI를 호출하지 않는다. 누락/null/일반 choice와 composer-text 4경우의 written receipt와 CLI/supervisor 생존을 검증한다. 전용 socket은 finally에서 정리한다. Windows→WSL Ubuntu 24.04에서 2 tests/4 cases가 통과했고 Node 공개 SDK 66/66도 통과했다. 회사 CLI 호환성 결과가 아니다.
