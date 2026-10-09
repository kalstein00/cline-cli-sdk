# 자유 응답과 TUI 입력 (#5)

고정 공개 Cline 3.0.69 Linux x64 fingerprint와 40×120 PTY에서 질문의 자유 응답을 지원한다. [연결](live.md), [응답의 대상·중복 방지·전달 상태](interactions.md) 계약을 그대로 사용한다. 회사 fork는 미검증이다.

```js
await client.start({ cwd, dataDir, prompt, terminalMode: "tui" });
const state = client.snapshot();
if (state.interaction?.responseKinds?.includes("text")) {
  await client.respond({
    sessionId: state.sessionId,
    executionId: state.executionId,
    interactionId: state.interaction.id,
    revision: state.revision,
    requestId: crypto.randomUUID(),
    answer: "2 custom identifier",
  });
}
```

SDK `start.terminalMode`는 `readline | tui`이며 생략하면 기존 readline을 유지한다. 웹 예제는 자유 응답용 TUI를 기본 선택한다. `capabilities().freeText`와 현재 interaction의 `responseKinds`를 함께 확인한다. 승인·recovery·미지원 화면에는 text를 활성화하지 않는다. replay는 읽기 전용이다.

readline은 CLI 자체의 trim→parseInt 규칙 때문에 현재 선택지 번호 1..N으로 시작하는 문자열을 선택지로 해석한다. `2 custom identifier`, `02...`, `+2...` 같은 해당 응답은 **입력 전** 거부한다. 접두사를 추가하거나 원문을 바꾸지 않는다. 일반 custom 응답은 정확한 문자열과 별도 제출을 CLI의 검증된 readline 경로로 보내고 같은 tool_result를 확인한다. 숫자 선행 custom이 필요한 작업은 처음부터 TUI로 시작한다.

TUI는 현재 하단 질문의 question/options를 읽기 전용 history의 미해결 ask_question tool_use와 유일하게 연결한다. 현재 selected row와 custom echo를 xterm으로 복원한다. custom 행으로 이동하고 그 선택을 확인한 뒤 64 UTF-8 바이트 이하의 grapheme 경계 청크를 보낸다. 각 청크의 누적 echo가 정확히 일치할 때만 다음 청크를 보낸다. 완성된 echo 이후 **별도 Enter**를 보낸다. 다른 modal·관측 누락·대상 변경·echo 불일치에서는 제출하지 않는다. `delivered`는 같은 tool_use_id의 tool_result 내용 SHA-256이 원문과 일치해야 한다. SSH/FIFO write나 화면에서 텍스트가 사라지는 것만으로 전달을 확정하지 않는다. polling은 관측 계기이며 고정 지연을 완료 보장으로 사용하지 않는다.

질문 modal의 bracketed paste는 이 CLI에서 무효였으므로 사용하지 않는다. main composer의 paste/submit 규칙은 다르며 대화 재개는 #9에서 다룬다. `--tui <request>`는 첫 요청을 자동 제출한다. SDK가 다시 입력하거나 Enter를 중복 전송하지 않는다. CLI 초기 광고 dialog가 입력을 가로채지 않도록 프로세스에만 `CLINE_DISABLE_CLINE_PASS_NOTICE=1`을 설정한다. `CLINE_NO_AUTO_UPDATE=1`도 유지한다. 전역 설정·provider 파일을 변경하지 않는다. 예상 밖의 추가 dialog는 미지원이다.

지원하는 응답은 비어 있지 않은 printable 단일 행, UTF-8 최대 1024바이트이며 앞뒤 공백·제어문자·불완전 surrogate를 거부한다. 한 grapheme이 64바이트를 넘는 조합도 전송 전에 거부한다. CLI trim을 따라 원문을 조용히 변경하지 않는다. 현재 question/options와 입력 전체가 관측 가능한 modal에 남아야 하며, 스크롤·화면 덮임 때문에 전체 echo를 확인할 수 없으면 전달 불명으로 남는다. Unicode 11 cell-width addon으로 한글·emoji 뒤 공백의 위치를 복원한다. [xterm 공식 사용법](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-unicode11/README.md)을 따르며 addon 0.8.0을 고정했다.

원격 단계별 ledger는 하나의 logical request에 최대 128개의 단조 step index를 묶는다. 같은 step은 payload digest가 같아도 다시 쓰지 않는다. 후속 step은 이전 step의 written witness가 있어야 하며 submit 이후 continuation은 금지한다. 최소 제어 메타데이터에는 digest·종류·상태·시각만 남긴다. 중간 입력 뒤 오류는 전체 응답의 전달 불명이며 새 요청과 자동 재전송을 차단한다. 첫 step의 명시적인 쓰기 전 거부만 not-submitted다. 기존 256 logical request 제한을 유지한다.

TUI spinner는 질문 위에서 계속 redraw하므로 raw cursor의 불변만 요구할 수 없다. 각 전송에서 현재 task-owned tmux pane의 하단 modal hash와 PID/starttime/boot ID·session·history SHA를 다시 대조한다. readline의 raw cursor guard는 유지한다. `status.modalPane`에는 capture-pane의 실제 바이트(base64), rows/cols, modal SHA를 반환해 관측·진단에서 guard를 재현할 수 있게 한다. 예제는 이를 파싱하지 않는다. 평상시 SDK가 로컬 대화를 영구 저장하지 않는 원칙도 유지한다.

## 재현과 실제 확인

격리 인증·키/agent·고정 CLI 준비는 [live.md](live.md)를 따른다. 각 시험은 별도 소유자 전용 remoteRoot/cwd/dataDir를 사용한다. provider 사본은 원격 안에서만 만들고 내용을 출력하지 않는다. Windows→WSL 시험에서는 해당 시험이 소유한 WSL keepalive만 유지/정리한다.

```powershell
npm ci
npm test
$env:CLINE_SDK_HOST = 'wsl'
$env:CLINE_SDK_CLI_PATH = '/absolute/path/to/pinned/cline'
$env:CLINE_SDK_REMOTE_ROOT = '/owned-test/control'
$env:CLINE_SDK_WORKSPACE = '/owned-test/work'
$env:CLINE_SDK_DATA_DIR = '/owned-test/data'
node examples/node/text.mjs
$env:CLINE_SDK_PORT = '4185'
npm run example:web
```

Node 예제는 통제된 run_commands 승인 후 네 질문에 순차로 응답하며 공개 SDK의 delivered 결과와 마지막 assistant TEXT_ALL_RECEIVED를 확인한다. 300초는 수용 harness 관측 마감이고 CLI 작업 수명을 제한하지 않는다. 예제의 로그 보관은 사용자가 명시적으로 수행하는 수용 기록이며 평상시 SDK가 생성하는 영구 대화가 아니다.

2026-10-09 Windows Node → native OpenSSH wsl → Ubuntu-24.04, Python 3.12.3, tmux 3.4에서 실제 공개 API를 실행했다. 고정 fingerprint·새 격리 lab을 사용했다.

| 입력                                       | bytes | 실제 session / 결과                                       |
| ------------------------------------------ | ----: | --------------------------------------------------------- |
| CUSTOM-42                                  |     9 | 1791545362546_zk9lw, same-tool result exact / delivered   |
| 2 custom identifier                        |    19 | 같은 session, exact / delivered                           |
| 한글 응답 가나다 😀 café                   |    34 | 같은 session, exact / delivered                           |
| LONG* + 알파벳/숫자 36자를 20회 반복 + *끝 |   729 | 1791545552326_5a8zu, exact / delivered, TEXT_ALL_RECEIVED |

첫 세 응답은 run-b1441228-a2a2-4c12-b500-a8d7a959aed1이고 긴 응답은 run-3f0230ff-42cc-47e8-88a1-5866688536d9다. 읽기 전용 remote tool_result와 원문을 독립 대조했다. 긴 입력 SHA-256은 eef51a4beeb6c9d2852ec06a92ad0ea9e81dac8b5fbc8fa725000b93e3cae6f3다. TUI CLI는 응답 후 composer를 유지하므로 이 수용은 전달 확인이며, process exit가 없는 상태를 completed로 위장하지 않는다.

이 과정의 실패도 보존했다. 기본 Unicode6이 emoji를 1셀로 읽어 공백이 늘어난 echo, wrapped continuation의 첫 문자 누락은 제출 Enter 이전에 timeout/불명으로 남았다. 원격 질문이 그대로 남았고 자동 재전송하지 않았다. 실제 원시 구간으로 `tui-korean-echo.json`, `tui-wrapped-echo.json`을 만들고 수정했다. 초기 광고 dialog의 입력 가로채기는 차단했고 process env로 후속 실행에서 제거했다.

33개 자동 시험의 주 접점은 SDK 공개 API다. `fixtures/text`의 원시 PTY/history는 기존 숫자 선행 성공·readline 오해와 새 Korean/wrapped 실측을 비식별화했다. Unicode 내부 바이트 분할·echo 누락·추가 modal은 fault injection으로 구분하며 실제 회사망 장애라고 주장하지 않는다. 브라우저 수용 증거는 검증 후 이 문서에 추가한다.

readline 공개 API도 run-e467ddbe-dfb5-47b8-92ee-aff5a7d3328d / session 1791545834339_16j3i에서 CUSTOM-42 delivered, TEXT_ALL_RECEIVED, 실제 completed를 확인했다.

Windows Chrome 브라우저에서 run-87b3f2b0 / session 1791546006240_h90vg의 승인과 네 자유 응답을 실제 DOM 입력·클릭으로 수행했다. 각 delivered 뒤 다음 질문으로 이어졌고 마지막 729바이트 응답은 revision 36 delivered와 TEXT_ALL_RECEIVED로 확인됐다. 같은 session의 네 tool_use→tool_result를 읽기 전용으로 독립 대조해 9/19/34/729바이트 원문과 일치했다. [최종 화면](evidence/ticket-5-all-received.jpg). TUI CLI의 idle 상태를 종료 completed로 표시하지 않았다.
