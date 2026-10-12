# 설치된 WSL CLI의 기본 저장 방식과 지원 계약

2026-10-12 사용자가 #33–#37의 관측·구현 대상을 현재 `ssh wsl`의 CLI로 지정했다. #30에 첨부한 회사 도움말과 이 CLI의 도움말은 다르다. 이 문서는 현재 WSL의 실제 실행 근거이며 회사망 호환성은 `unverified`다. #13과 부모 #30의 회사 최종 수용을 대체하지 않는다.

## 관측 대상

Windows OpenSSH → `wsl` → Ubuntu Linux, Python 3.12.3, tmux 3.4, PTY와 Linux pidfd를 확인했다. 설치나 전역 CLI 업데이트를 수행하지 않았다. 도움말을 조회한 뒤 실제 모델 요청도 실행했다.

| 항목 | 관측값 |
| --- | --- |
| 선택한 launcher | `/home/kalstein/.local/share/fnm/node-versions/v22.22.0/installation/lib/node_modules/cline/bin/cline` |
| launcher SHA-256 | `37848dcde533871a1a95af479221c8768292652ae73c73a8825288a67470f355` |
| 실행 바이너리 | 같은 `bin` 디렉터리의 `.cline` (설치 launcher가 선택한 Linux 실행 파일) |
| 실행 바이너리 SHA-256 | `ff8383346760e4bcf56fbeb230e6dd7b6b526e6e0231ed6fd7f035e2887f6af7` |
| 기본 대화 기록 | `/home/kalstein/.cline/data/sessions` |
| 도움말 종료 | 0, stdout 옵션 관측 성공 |
| 공통 실행 옵션 | `--cwd`, `--auto-approve`, `--tui`, `--id` |
| 회사 도움말과 차이 | 현재 WSL에는 `--data-dir`, `--zen`, `--acp` 등이 있다. 회사 도움말과 동일 CLI라고 판정하지 않는다. |

SDK `cliHash`는 사용자가 선택한 실행 경로의 파일 해시다. launcher 내부 실행 파일까지 자동 검증하는 해시가 아니다. 바이너리를 직접 고정하려면 `cliPath`에 바이너리 절대 경로를 지정한다. 이 관측은 launcher와 바이너리 해시를 따로 기록했다. 버전 번호는 조회하거나 지원 판정에 사용하지 않았다.

## 저장·실행 계약

```js
const client = createClient({
  mode: 'live',
  connection: {
    host: 'wsl',
    storageMode: 'native',
    cliPath: '/absolute/path/to/installed/cline',
    remoteRoot: '/remote/sdk-control',
    // sessionDirectory: '/observed/cli/sessions', // 기본 위치가 다를 때
  },
});
const report = await client.connect();
if (!report.ready) throw new Error(report.problems.join(', '));
await client.start({cwd: '/existing/workspace', prompt: 'Hello', terminalMode: 'tui'});
```

`native`는 `dataDir`을 거부하고 시작·재개에 `--data-dir`을 전달하지 않는다. 기존 원격 인증·설정을 복사하거나 변경하지 않는다. 예제 앱은 `native`가 기본이며, SDK의 기존 기본값 `isolated`와 명시적 격리 실행은 유지한다.

설치 바이너리의 저장 경로 함수와 실제 생성 파일을 대조했다. 현재 프로필의 경로 우선순위는 `CLINE_SESSION_DATA_DIR` → `CLINE_DATA_DIR/sessions` → `CLINE_DIR/data/sessions` → `~/.cline/data/sessions`다. 빈 환경 값은 무시한다. 명시적 `sessionDirectory`는 관측할 경로를 선택하며 CLI의 저장 환경을 바꾸지 않는다. 기존의 절대 경로·읽기와 탐색 권한을 요구하고 확인되지 않으면 `native-storage-unconfirmed`로 시작을 차단한다. 다른 CLI의 저장 형식은 이 경로 규칙으로 확인됐다고 가정하지 않는다.

입력 `cwd`는 작업할 폴더다. 원격 절대 경로가 아니거나, 없거나, 파일이거나, 탐색 권한이 없으면 `working-directory-invalid`, `working-directory-not-found`, `working-directory-not-directory`, `working-directory-access-denied`를 반환한다. 실행 전 확인된 오류에는 `notSubmitted: true`가 붙고 연결과 초안을 유지한다. 폴더를 자동 생성하거나 권한을 변경하지 않는다.

도움말은 stdout·stderr 각각 최대 64 KiB, 최대 10초로 관측한다. 색 제어 문자를 제거해 옵션을 추출한다. 성공적으로 관측한 도움말의 실제 누락만 `missingOptions`로 보고한다. 실패·timeout·잘림·해석 불가에는 `missingOptions: null`을 반환해 옵션 부재와 구분한다. tmux는 필수이며 자동 설치하지 않는다.

## 대화·프로세스 결합

관측 manifest는 `<sessions>/<sid>/<sid>.json`의 `session_id`, `pid`, `cwd`, `status`를 제공한다. 대화는 `<sid>.messages.json`의 `{version: 1, sessionId, messages}`다. 내용에는 user/assistant, text/thinking, tool_use/tool_result가 있고 완료 응답에 token metrics가 기록된다. 질문 도구는 `ask_question`, 승인 대상은 `run_commands`였다. 120×40 TUI의 현재 modal·커서·composer 근거를 실제 질문·입력으로 확인했다.

시작 전에 저장영역의 대화 디렉터리 이름만 기억한다. 새 후보의 manifest는 일반 파일만 최대 64 KiB로 읽고 SDK 소유 launcher 또는 자식의 PID·start time·boot ID가 모두 확인된 경우에만 SID를 결합한다. 이전 대화의 manifest/history는 열지 않는다. 동시 생성된 외부 대화의 PID는 SDK 소유 트리에 없으므로 선택하지 않는다. 후보가 모호하거나 256개를 넘으면 결합하지 않는다. SID가 확정된 뒤에는 그 대화의 파일만 읽는다. history는 최대 16 MiB로 읽으며 미지원 version은 경고와 입력 차단으로 표시한다. 파일은 읽기 전용이며 부분/교체/읽기 실패는 마지막 정상 상태를 보존한다. preflight ready는 저장 형식의 실제 호환성을 보증하지 않는다.

현재 TUI의 `auto` backend는 사용자 공유 hub에 작업을 넘길 수 있다. 실제 첫 실행에서 manifest PID가 SDK 트리 밖에 있어 입력을 차단했다. 환경의 `CLINE_SESSION_BACKEND_MODE=local`도 TUI가 명시하는 `auto`에 의해 무시됐다. 이를 회사 CLI의 지원 옵션이라고 일반화하지 않는다.

현재 WSL 프로필은 실행별 SDK 제어 경로의 `CLINE_HUB_DISCOVERY_PATH`와 전용 loopback 포트·`CLINE_HUB_PATHNAME`을 사용해 CLI 자신의 hub를 분리한다. 기존 settings·sessions 위치는 유지한다. 포트 확보 뒤 bind 경합이 발생하면 CLI 실행/소유권 확인이 실패할 수 있으며 임의 공유 hub를 채택하지 않는다. SDK subreaper가 전용 daemon까지 소유 자식으로 추적한다. 입력 대기 판단에서 제외할 daemon은 SDK 소유 identity, 전용 discovery PID, `/proc`의 daemon argv와 실행별 환경이 모두 맞아야 한다. 도구 자식은 입력을 차단하며 중단은 daemon을 포함한 전체 소유 트리를 대상으로 한다. 사용자의 공유 hub에 signal을 보내지 않는다.

재접속은 같은 SID/EID/프로세스를 attach한다. 명시적 중단은 모든 소유 자식 종료를 확인한다. 재개는 종료 확인된 같은 SID에 `--id`로 새 EID를 만든다. 전달 원장·history·현재 화면을 다시 대조하며 불명 상태에서 자동 재전송하지 않는다. 기존 파일의 직접 수정·삭제는 없다.

## 실제 확인과 재현

SDK 공개 API로 기존 인증을 사용해 다음을 실제 실행했다. 인증·설정 원문을 출력하거나 사본을 요구하지 않았다.

- `SDK_NATIVE_API_READY` → 후속 `SDK_NATIVE_NEXT` → SDK 재생성/attach → 소유 프로세스 중단 confirmed → 같은 SID, 새 EID의 `SDK_NATIVE_RESUMED`.
- RED/BLUE 질문의 BLUE 선택, 이어지는 별도 질문의 `2 한글 identifier` 자유 응답을 원문으로 전달했다.
- `printf SDK_APPROVAL > approved-marker`를 승인해 파일 생성, 별도 `denied-marker` 명령을 거절해 파일이 생성되지 않는 것을 확인했다. 명령은 시험 소유 작업 디렉터리에만 실행했다.
- 시험에서 CLI가 만든 대화는 기존 저장영역에 보존했다. SDK 실행만 명시적으로 중단했다. 실제 WSL 종료/재부팅이나 회사망 실행은 시험하지 않았다.

최소 fixture [wsl-question.json](../../fixtures/native/wsl-question.json)은 실제 tmux capture와 커서, 해당 시점의 ask_question tool call만 보존한다. SID/작업 경로를 가렸고 ANSI 전체 화면으로 재표현하며 색은 생략했다. 인증·환경 metadata·system prompt·이전 대화는 포함하지 않는다. 이 변환과 바이너리 해시는 provenance에 기록했다. 공개 replay 시험은 같은 decoder에서 질문·선택·자유 응답 허용을 확인하며 실제 응답 전달을 대신하지 않는다.

`tests/native-storage.test.mjs`는 시험 소유 CLI와 별도 저장영역으로 no-data-dir, 한글/공백 cwd, 기존/동시 대화 혼입 차단, 전용 daemon 근거 누락 시 입력 차단, 후속 전달, 앱 재생성, 자식 중단·재개를 검증한다. 모델을 호출하지 않는다. 기존 공개 API/브라우저 시험이 오래된 입력·중복 요청·부분 기록·전달 불명을 검증한다. 설치된 CLI 실측과 이 통제 장애 주입을 구분한다.

설치된 CLI의 실제 브라우저 시험은 명시적 opt-in이다. 기존 provider의 모델을 호출하고 CLI가 생성한 시험 대화를 보존한다. 전체/브라우저 시험은 [완료 이벤트 절차](../test-runner-plan.md)를 따른다.

```powershell
$env:CLINE_SDK_TEST_NATIVE_CLI = '/absolute/path/to/installed/cline'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run-tests-and-notify.ps1 -Background -ThreadId $env:CODEX_THREAD_ID -SshHost wsl
```

브라우저 시험은 기존 저장 모드, 질문 대기에서 연결 해제/복구, 숫자 선행 한글 응답, 승인 실행/거절 미실행, Node 서버 재시작 후 동일 프로세스 attach, 중단과 같은 대화 재개를 검사한다. 제출 직후 장애·원격 재부팅은 이 설치 CLI 브라우저 시험의 실제 장애 조건에 포함하지 않으며 기존 통제 시험과 구분해 보고한다.
