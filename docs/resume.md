# 종료된 대화 재개 (#9)

`resume`는 종료 확인된 관리 실행의 대화를 같은 session ID로 이어가며 새 execution ID를 만든다. 살아 있는 실행에 다시 연결하는 [attach](reconnect.md)와 구분한다. 고정 공개 Cline 3.0.69 Linux x64 fingerprint에서만 지원하며 회사 fork는 미검증이다.

```js
const executions = await client.listManagedExecutions();
await client.attach(selectedExecutionId);
// capabilities().resume는 현재 관측 기준이다. resume에서 다시 원격 증거를 확인한다.
if (client.capabilities().resume) {
  const state = await client.resume({
    executionId: selectedExecutionId,
    requestId: crypto.randomUUID(),
    prompt: "Ask ask_question: RESUME_FOLLOWUP, options RED,BLUE. Print RESUME_RESULT:<answer>. No other tools.",
  });
  console.log(state.sessionId, state.executionId, state.resume.state);
}
```

현재 후속 요청은 앞뒤 공백이 없는 printable 단일 행, UTF-8 최대 **112바이트**다. 40×120 composer의 한 행에 전체 echo를 확인할 수 있는 범위로 제한했다. 한 grapheme은 64바이트 이하다. 줄바꿈·제어문자·불완전 surrogate·선행 `/` 명령·`@` mention은 실행을 만들기 전에 거부한다. 큰 paste·여러 행·잘린 echo를 추측해서 제출하지 않는다. 이후 질문의 숫자 선행·한글·emoji·긴 자유 응답은 [#5의 검증된 계약](text.md)을 그대로 사용한다.

재개 전에는 같은 boot/PID/starttime의 CLI가 사라졌고, supervisor의 실제 종료와 모든 소유 자식 종료가 확인되어야 한다. 정상 완료는 실제 exit 0·CLI completed history/manifest 증거를 함께 사용한다. 중단은 #8의 confirmed receipt·childrenVerified·빈 remaining이 필요하다. CLI 부재만 확인했거나 중단 결과가 unknown이면 재개를 차단한다. 선택한 실행뿐 아니라 같은 SID의 다른 관리 실행과 아직 PID를 얻지 못한 pending 실행도 원격에서 확인한다.

원격 소유자 전용 lock 아래 이전 실행에 재개 예약을 먼저 남긴다. 같은 request ID는 기존 예약의 결과만 확인하고, 이미 예약된 이전 실행에 다른 ID로 새 실행을 만들지 않는다. 불명확한 launch를 자동으로 재시도하지 않는다. 이전 실행의 최소 메타데이터에는 후속 실행 ID·요청 digest·history 경계 count/마지막 message ID를 남기며 요청 본문은 남기지 않는다. CLI settings와 history는 SDK가 수정하지 않는다.

고정 CLI에서 `--id <sid>`는 argv의 prompt를 버린다. 그래서 새 실행에는 `--id`만 전달하고 이전 history가 복원된 **빈 Act composer**, 실제 focused cursor·상하 rule·footer와 modal 부재를 확인한다. printable 요청을 grapheme 경계의 64바이트 이하 청크로 보낸 뒤 각 누적 echo를 확인한다. 전체 echo 뒤에 별도 Enter를 전송한다. 고정 지연을 완료 보장으로 사용하지 않는다. `snapshot.resume.state === "delivered"`는 이전 history 경계 뒤에 같은 요청 원문을 가진 새 user message가 정확히 하나 저장되었음을 확인한 결과다. 입력 write나 composer가 비어지는 것만으로 확정하지 않는다.

이 CLI는 user text를 `<user_input mode="act">…</user_input>`로 저장한다. 고정 primary source의 `u2` 함수(byte 81606274)와 실제 history를 확인했다. SDK는 알려진 프로필의 정확한 전체 wrapper만 벗겨 소비 앱에 요청 원문을 표시한다. 일반 문자열에 포함된 tag는 변경하지 않는다. 전달 digest도 같은 검증된 wrapper의 원문을 대조한다.

이전 메시지 ID는 유지하며 새 실행에서 response/stop/phase 상태를 새로 시작한다. 과거 execution ID·interaction ID·revision의 응답은 입력 전에 차단한다. 후속 요청의 echo·수신 증거를 잃으면 resume 전달 불명으로 남기고 Enter·응답·자동 재전송을 차단한다. `resume` 실패 뒤 다른 request ID로 launch를 반복하지 않는다. 재연결은 새 실행을 만들지 않는다.

최초 발견한 SID는 현재 process metadata와 별도 `session.json`에 보관해 status 조회가 동시 exit write를 덮어쓰지 않게 했다. SID가 알려지면 해당 CLI history를 읽는 데 현재 manifest PID 일치를 요구하지 않는다. 재개로 manifest PID가 바뀌어도 이전 실행의 SID/history는 유지한다. 이전 실행의 종료 witness는 별도로 보존하며 이후 실행의 manifest 상태로 과거 실행 결과를 바꾸지 않는다.

## 재현 명령과 실제 증거

격리 인증·고정 CLI·WSL keepalive 준비는 [live.md](live.md)를 따른다. provider는 원격 안에서 소유자 전용 시험 사본으로 준비하고 원문을 출력하지 않는다.

```powershell
npm ci
npm test
$env:CLINE_SDK_HOST = 'wsl'
$env:CLINE_SDK_CLI_PATH = '/absolute/path/to/pinned/cline'
$env:CLINE_SDK_REMOTE_ROOT = '/owned-test/control'
$env:CLINE_SDK_WORKSPACE = '/owned-test/work'
$env:CLINE_SDK_DATA_DIR = '/owned-test/data'
node examples/node/resume.mjs
$env:CLINE_SDK_PORT = '4189'
npm run example:web
```

Node 예제는 정상 readline 완료와 TUI 질문 대기 중 명시적 중단을 각각 재개한다. 이후 질문에 숫자 선행/한글 응답을 전달하고 `RESUME_RESULT:<answer>`를 확인한 뒤 예제 소유 TUI 실행을 명시적으로 중단한다. 240초는 수용 harness의 관측 마감이며 CLI 작업 수명 보장이 아니다.

2026-10-09 Windows Node → native OpenSSH wsl → Ubuntu-24.04에서 공개 API를 실행했다. 고정 hash `8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032`, Python 3.12.3, tmux 3.4, 격리 lab `/home/kalstein/cline-sdk-ticket9-20261009-resume`을 사용했다.

| 이전 실행 / 종료 증거 | 같은 session ID / 새 실행 | 후속 질문 결과 |
| --- | --- | --- |
| run-cd2a7775-65f1-4631-8d2a-c39b0a8ab8aa, readline completed·childrenVerified·supervisor 부재 | 1791548237289_7e94n / run-82f93a3d-d751-4f93-a9ac-3c2bd6e93932 | `2 custom identifier` 19바이트 delivered, `RESUME_RESULT:2 custom identifier` |
| run-f8440952-f365-4c8b-9b61-40d53e9ed445, SDK stop confirmed·childrenVerified·supervisor 부재 | 1791548271064_fx6eu / run-d6acd6d3-99df-4acc-9096-a9dd1457f5e2 | `한글 응답 가나다 😀 café` 34바이트 delivered, 같은 원문의 RESUME_RESULT |

두 resume 모두 복원 composer→echo→별도 Enter→새 stored user message로 delivered를 확인했다. 이전 메시지 수 2→3 및 1→2로 후속 user message 추가를 확인했다. TUI가 idle로 남는 상태를 자연 completed로 위장하지 않았다. 두 후속 TUI 실행은 SDK stop confirmed로 정리했고 대화는 보존했다.

`fixtures/resume`에는 실제 기존 composer restore/echo와 이번 정상·중단 재개 원시 PTY/최종 history를 넣었다. 최종 history는 trace 뒤에 실제 읽은 것으로, 중간 history를 만들어 넣지 않았다. provenance의 source hash·선택/잘림을 보존했다. 공개 replay에서 이전 메시지·후속 user text·숫자/한글 결과를 확인한다. 별도 OpenSSH 경계 fault injection은 CLI/자식/중단 불명, 중복 resume, write 뒤 echo 누락, 오래된 응답을 검증한다. fixture/fault 시험을 회사 환경 재시험으로 주장하지 않는다.
