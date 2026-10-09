# 선택·승인·거절 상호작용 (#4)

고정 공개 Cline 3.0.69의 readline 경로에서 `ask_question`과 `run_commands`의 승인/거절, 선택 질문, 거절 뒤 `mistake_limit_reached` 선택을 지원한다. 회사 fork는 미검증이다. 자유 응답과 TUI 입력은 #5의 범위이며 이번 단계에서는 전송하지 않는다.

## 공개 API

연결·실행 설정은 [live.md](live.md)를 따른다. 소비 앱은 SDK의 현재 snapshot으로 응답 대상을 구성한다.

```js
const state = client.snapshot();
const result = await client.respond({
  sessionId: state.sessionId,
  executionId: state.executionId,
  interactionId: state.interaction.id,
  revision: state.revision,
  requestId: crypto.randomUUID(), // 재클릭·재호출에는 같은 ID를 재사용
  answer: state.interaction.choices[0], // 표시된 선택지의 정확한 문자열
});
```

`Interaction.kind`는 `approval | question | recovery | unsupported`다. 검증된 승인에는 `toolId`, `toolName`, 읽기 전용 `toolInput` 전체와 `choices: ['Approve','Deny']`를 제공한다. 화면의 잘린 JSON만으로 승인하지 않는다. 같은 실행의 현재 history에서 아직 결과가 없는 tool_use를 찾고, 실제 화면의 도구 이름·전체 JSON 또는 검증 가능한 긴 preview prefix와 유일하게 대조한다. 일치하지 않거나 여러 도구가 해당하면 미지원이다. 소비 앱은 전체 toolInput을 보여주고 승인/거절을 받는다.

선택 질문의 choice 문자열을 숫자 입력으로 바꾸는 책임은 SDK에 있다. 선택지의 수·중복·현재 도구 연결을 확인한 뒤 검증된 readline 입력만 전달한다. 숫자 선행 문자열과 한글을 선택지로 임의 변형하지 않는다. 정확히 일치하지 않는 `answer`는 `unsupported-answer`로 입력 전에 거부한다. 승인과 실제 질문은 같은 toolId라도 다른 interaction ID이며, 거절 뒤 CLI 자체의 재시도 제한 질문도 별도의 recovery ID다.

각 상호작용의 `responseKinds`는 현재 허용된 `approval` 또는 `choice`를 명시한다. `text`는 후속 기능을 위한 타입이며 현재 제공하지 않는다. live `capabilities()`의 `responses:true`, `freeText:false`와 현재 interaction의 `responseKinds`, 상태를 함께 사용한다. replay는 읽기 전용이다. 미확인 프로필·프롬프트·누락한 원시 관측·history 연결은 입력을 차단한다. 일반 터미널 입력 우회 API는 없다.

## 요청 정체성과 전달 상태

session·execution·현재 interaction·현재 snapshot revision을 먼저 확인한다. 같은 requestId와 동일한 응답은 진행 중 Promise 또는 기존 결과를 반환한다. 같은 requestId를 다른 답변에 재사용하면 `request-conflict`다. 서로 다른 requestId로 같은 질문을 동시에 제출해도 첫 요청이 첫 await 전에 예약되므로 다른 요청은 `response-busy`이고 두 번째 원격 입력은 없다. 지난 interaction·revision·다른 session/run·자유 응답은 원격 입력 전에 거부한다.

전송 직전 전체 원격 상태를 다시 읽는다. 원격 helper와 PTY supervisor가 모두 현재 Linux PID/starttime/boot ID, session, terminal cursor, history SHA를 대조한다. 이미 준비된 PTY 출력부터 읽고 FIFO 입력을 검사한다. 오래된 질문에 입력이 넘어가는 것을 막기 위해 관측이 바뀌었으면 쓰기 전에 거부한다.

| `snapshot.response.state` / 결과 state | 의미 |
| --- | --- |
| `submitting` | 대상에 묶인 요청을 예약하고 수신 근거를 확인 중. 응답 컨트롤을 잠근다. |
| `delivered` | 같은 tool_result, 같은 도구의 승인→실제 질문 전환 또는 검증된 recovery 전환·종료로 CLI 수신을 확인. 작업 성공을 뜻하지 않는다. |
| `delivery-unknown` | 전송 중 연결 상실·불확실한 실패·관측 마감. 자동 재전송과 새 응답을 차단한다. 복구 판정은 #7에서 확장한다. |
| `not-submitted` | helper/supervisor가 명시적으로 **쓰기 전** 거부한 요청. 마지막 질문을 새 상태로 확인한 뒤 사용자가 새 요청을 할 수 있다. SDK가 재시도하지 않는다. |

`respond()`는 전달 확인 결과를 반환한다. 전송 오류는 SdkError로 보고하고 snapshot에 불명 상태를 보존한다. SSH write 성공 또는 FIFO write witness만으로 delivered를 표시하지 않는다. 기본 관측 마감은 30초이며 `connection.responseTimeoutMs`는 250–120000ms로 설정할 수 있다. polling 간격은 확인 계기이며, 고정 시간 경과를 수신 확인으로 취급하지 않는다.

`response.changed` 이벤트는 requestId·sessionId·executionId·interactionId·revision과 ResponseResult payload를 제공한다. 메시지·상호작용·연결·실행 이벤트와 구분한다. 새 질문이 나타나도 이전 요청의 수신 불명이 저절로 사라지지 않는다.

원격 소유자 전용 `requests.json`에는 요청 binding, 답변 SHA-256, queued/written/rejected 및 시각만 남긴다. 답변 원문·인증 정보·전체 대화를 제어 메타데이터에 저장하지 않는다. 같은 도구+단계의 queued/written 요청이 있으면 다른 requestId도 두 번째 입력을 차단한다. FIFO는 작은 JSON 제어 프레임을 원자적으로 받고 PTY에 승인 또는 숫자+Enter만 쓴다. 완료 여부 불명 요청은 재전송하지 않는다. 로컬·원격 요청 목록은 실행당 256개로 제한하며, 한도 초과 때 기존 중복 방지 기록을 버리지 않는다. 이 ledger는 재접속 시 원래 실행에 붙는 #6/#7의 기반이며 해당 복구 수용 자체는 아직 수행하지 않았다.

recovery의 `Stop this run`은 실제 쓰기 witness와 같은 실행의 종료 witness가 있으면 `stopped`로 분류한다. exit 0·manifest completed·이전 planning 메시지 조합을 정상 성공으로 표시하지 않는다. Cline이 recovery를 연 뒤 마지막 assistant 문장을 같은 readline 줄에 늦게 출력하는 실측 경로에서는, 답하지 않은 현재 recovery와 footer·커서 한 줄 전진을 함께 확인해 ID를 유지한다. 과거 scrollback의 메뉴를 다시 찾지 않으며 입력·새 화면·종료에서는 닫는다. 이 상태 분류는 실행 중 자식 명령 종료를 검증하는 #8의 작업 중단 API 수용을 대신하지 않는다.

## 재현

키 또는 SSH agent와 기존 host 검증을 사용한다. 고정 CLI와 격리 작업·dataDir의 준비는 [live.md](live.md)의 원격 사용자 권한 절차를 따른다. 인증 파일은 원격 내부에서만 소유자 전용으로 복사하며 내용을 로그로 출력하지 않는다.

```powershell
npm ci
npm test
$env:CLINE_SDK_HOST = 'wsl'
$env:CLINE_SDK_CLI_PATH = '/absolute/path/to/pinned/cline'
$env:CLINE_SDK_REMOTE_ROOT = '/remote/owned-lab/control'
$env:CLINE_SDK_WORKSPACE = '/remote/owned-lab/work'
$env:CLINE_SDK_DATA_DIR = '/remote/owned-lab/data'
$env:CLINE_SDK_RETRY_LIMIT = '1'
npm run build
node examples/node/interactions.mjs choice
node examples/node/interactions.mjs approve
node examples/node/interactions.mjs deny
```

`start.retryLimit`는 명시한 경우에만 CLI `--retries`로 전달한다. 허용 범위는 정수 1–10이며 지정하지 않으면 CLI 기본값을 유지한다. 위 값 1은 통제된 거절 뒤 recovery를 재현하는 조건이다. 평상시나 전역 CLI 설정을 바꾸지 않는다.

웹 예제는 `CLINE_SDK_PORT`를 설정해 `npm run example:web`으로 실행한다. 연결→작업 시작→승인/거절→선택을 같은 공개 API로 수행한다. 전체 도구 인자를 표시하고 submitting/unknown/unsupported에서는 응답 버튼을 비활성화한다. 응답·refresh 오류 때 서버가 반환한 SDK snapshot을 그대로 다시 표시하며 예제 전용 파싱이나 원격 입력은 없다.

## 검증 범위

자동 시험 26개는 SDK 공개 API를 주 접점으로 한다. 외부 OpenSSH boundary만 대체하고 실제 raw reducer를 사용한다. `fixtures/interactions/{choice,approve,deny}.json`은 2026-10-09의 검토한 원래 PTY 분할과 비식별 messages envelope다. 예상 이벤트를 바로 출력하지 않으며 원본 seq·상대 나노초·출처 SHA·변환 목록과 tool_use/tool_result 연결을 보존한다. 원문 system_prompt·provider·auth·thinking·사용자 text 컨텍스트와 개인 경로를 제거했다. 프로세스 stopped 분류·전송 실패는 명시적인 fault injection이며 실제 장애 실측으로 세지 않는다.

2026-10-09 Windows Node → SSH `wsl` → Ubuntu-24.04, 기존 고정 CLI hash, 소유자 전용 새 `cline-sdk-ticket4-20261009-71bc` lab에서 다음을 실제 공개 API로 확인했다.

- 선택: `run-8a7fca0f-73c2-4b56-96c5-195b4efd5813`, session `1791542948697_aiokw`. 승인 delivered 후 같은 tool의 새로운 question ID가 나타났고, BLUE delivered 후 assistant `SDK_COLOR:BLUE`, 실제 completed로 이어졌다.
- 도구 승인: `run-2803731d-3a02-41d2-9aff-3b729f7c0d71`, session `1791542992696_d8azx`. `printf APPROVAL_PROBE`를 승인하고 correlated tool result 및 assistant `SDK_APPROVED:APPROVAL_PROBE`, completed를 확인했다.
- 초기 거절 실측: 승인 Deny는 delivered였고 retry-limit recovery가 나타났다. recovery 응답 직전에 추가 출력이 발생해 cursor guard가 terminal-observation-changed로 **쓰기 전 거부**했다. 그 요청을 자동 재전송하지 않았다. 해당 실행은 별도의 진단 정리로 현재 PID/starttime/boot를 확인해 종료했으며 제품 stop 성공으로 세지 않는다. 이 관측을 반영해 not-submitted와 delivery-unknown을 구분했다.

Windows Chrome에서 같은 서버와 SDK 공개 API로 선택·승인·거절을 실제 수행했다. 선택 `run-cdec9171-…`, session `1791543519049_7g0vf`는 BLUE delivered → `SDK_COLOR:BLUE` → completed였다. 승인 `run-4ec99ea7-…`, session `1791543604842_un844`는 delivered → `SDK_APPROVED:APPROVAL_PROBE` → completed였다.

최종 거절은 `run-d8b51f72-…`, session `1791544054790_a6rum`에서 Deny delivered, recovery interaction:4가 나타났다. 늦은 `SDK_DENIED` 메시지 이후에도 같은 recovery ID가 유지됐고, Stop this run을 클릭하면 컨트롤이 잠긴 뒤 같은 실행의 stopped와 delivered(revision 17)로 이어졌다. CLI 거절 결과는 명령이 실행되지 않았음을 명시했다. exit 0을 completed로 잘못 표시하지 않았다. [현재 recovery 화면](evidence/ticket-4-recovery.jpg)과 [중단 및 전달 확인 화면](evidence/ticket-4-stopped.jpg)을 보존했다. Chrome의 실제 DOM 조작·결과와 최종 recovery/stopped의 화면을 확인했으며 초기 선택/승인의 당시 화면 캡처는 활성 탭 캡처 문제로 증거로 사용하지 않는다.

독립 임시 consumer에서 npm tarball을 설치해 공개 connect/preflight ready를 확인했다. tarball 8개 파일에 `remote/supervisor.py`가 포함된다. 회사망·TUI·숫자 선행/한글 자유 응답·중단 자식 종료·재접속 전달 판정은 이번 단계의 완료로 주장하지 않는다.

#5에서 추가한 현재 자유 응답·TUI 계약과 수용 근거는 [text.md](text.md)를 따른다. 위 내용은 #4 단계의 readline 기준선 기록이다.
