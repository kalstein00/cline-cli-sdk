# 유한한 진단 수집과 원시 기록 재생 (#11)

진단은 opt-in이다. `startDiagnostics({directory,maxBytes?,maxBundles?,retentionDays?})`, `diagnostics()`, `stopDiagnostics()`로 경로·수집 상태·바이트·관측 수·누락·실패를 확인한다. 기본 한도는 묶음당 16 MiB, 보관 5개, 7일이며 설정 범위는 4 KiB–256 MiB, 1–50개, 1–90일이다. journal과 manifest의 용량을 함께 제한한다. 초과하면 limit-reached/truncated, 저장 오류면 failed/failure code를 표시한다. 원격 작업을 중단하거나 사용자 입력을 재전송하지 않는다.

완료되었거나 수집 프로세스가 종료된 것으로 확인한 SDK 소유 묶음만 보관 정리 대상으로 삼는다. 진행 중인 수집은 삭제하지 않으며 수집 중 묶음이 개수 한도를 차지하면 새 수집은 diagnostic-bundle-limit으로 실패한다. SDK 이름·manifest marker를 확인하고, 소유 파일 외에 다른 파일이 있거나 디렉터리가 심볼릭 링크면 삭제하지 않는다. 평상시 수집 파일은 없다. connect 전에 수집을 시작하면 초기 연결부터 기록한다. 도중에 시작한 묶음은 누락한 앞 관측을 표시하고 full-screen/history 재관측을 요청한다. 비교 결과가 불일치할 수 있으며 expected snapshot을 초기 상태로 주입해 숨기지 않는다.

## 형식과 해석

각 로컬 디렉터리는 `manifest.json`과 `observations.ndjson`를 가진다. manifest는 format/schema 2, SDK 0.1.0, adapter version, CLI 프로필·실행 fingerprint, 터미널 크기, 시작/종료 시각, 한도·상태·누락·변환을 기록한다. 각 journal 줄의 observation은 SHA-256을 가진다. 파일 전체 SHA도 공개 read 결과에 남긴다. 해시가 바뀐 원시 관측은 diagnostic-hash-mismatch로 거부한다. 마지막 줄이 불완전하면 앞의 완전한 줄만 열고 truncated를 표시한다.

원시 관측과 비교용 sidecar는 같은 줄의 서로 다른 필드다. replayAll은 `recording.observations`만 해석하며 비교용 events/snapshot을 읽지 않는다. 비교는 mode와 재생 위치/전체 수 같은 재생 표시 메타데이터만 제외한다. 원래 연결·실행·질문 ID·revision·시각·requestId·전달 상태와 process/stop 증거는 대조 대상이다. 원래 schema 1의 검토된 fixture는 계속 지원한다. schema 2의 strict binding은 source live와 offline에서 같다.

| 원시 입력 | 보존 및 해석 |
| --- | --- |
| PTY | 실제 ANSI/UTF-8 바이트·분할·원래 sourceSeq·순서·시각. 실제 xterm headless/Unicode 11로 복원한다. |
| 터미널/phase | 현재 screen/modal pane, 크기, modal hash, cursor, gap, 원격 phase epoch/fingerprint. full-screen으로 복구할 때 이전 packet은 보존하지만 두 번 적용하지 않는다. |
| history/file read | 현재 messages envelope의 필요한 text/tool_use/tool_result와 linkage, 원래 파일 hash/byte count, read/missing/error. 잘못된 JSON은 원래 hash/크기와 명시적 invalid marker로 남긴다. |
| response input | session/run/interaction/revision/request binding, 답변 digest, 실제 승인/선택/문자/Enter/navigation 입력 단계. |
| response receipt/fault | 원격 durable reserved/queued/written/rejected/resolution, 같은 tool result·단계·process 근거, 오류/마감. 공유 deliveryState로 판정한다. |
| 연결/실행 조작/process | connecting/connected/disconnect/오류, 시작·세션 연결, stop request/실제 receipt, PID/starttime/boot·자식·종료 증거. 후속 resume/history-sync 사건도 이 원시 계약에 추가한다. |

SSH 설정·키·인증 provider/settings 파일은 수집하지 않는다. history의 system_prompt/provider/model/thinking/metrics 등 해석에 불필요한 필드를 제외한다. 진단에는 필요한 대화·도구 인자·명령 출력·사용자 응답이 포함되므로 그 내용의 임의 비밀까지 자동 제거했다고 주장하지 않는다. 반출 전 사용자가 내용을 검토하고 #12의 반출용 가림 처리를 사용한다. 원본은 수집 도중 수정하지 않는다.

## 재현

[현재 소비 앱 안내](usage.md)와 원격 환경 준비를 따른다.

```powershell
$env:CLINE_SDK_HOST='your-ssh-alias'
$env:CLINE_SDK_CLI_PATH='/absolute/pinned/cline'
$env:CLINE_SDK_REMOTE_ROOT='/owner-only/sdk-control'
$env:CLINE_SDK_WORKSPACE='/isolated/work'
$env:CLINE_SDK_DATA_DIR='/isolated/cline-data'
$env:CLINE_SDK_DIAGNOSTIC_DIR='C:/local/review-directory'
npm run build
node examples/node/diagnostics.mjs capture
node examples/node/diagnostics.mjs failure
node examples/node/diagnostics.mjs replay <출력된 기록 디렉터리>
```

failure 명령은 존재하지 않는 SSH 실행 파일을 명시적으로 선택하는 실제 로컬 실행 오류 실측이다. 회사망 장애로 주장하지 않는다. 자동 시험의 OpenSSH 응답 boundary만 대체한 자료와 구분한다. replay 명령은 connection options를 구성하지 않고 기록만 연다.

웹에서는 `다음 연결부터 원시 진단 수집`을 선택하고 연결·질문·응답을 수행한 뒤 `진단 종료·저장`, `기록 열기·오프라인 비교`를 사용한다. 경로·state·bytes·한도·truncated·failure 및 비교 차이를 같은 화면에 표시한다. 일반 질문 응답 중에도 SDK가 게시한 최신 snapshot을 읽어 수집 상태를 갱신한다. replay 응답·중단 컨트롤은 잠긴다.

## 실제 검증

2026-10-09 Windows Node → SSH wsl → 고정 공개 CLI/TUI, 소유자 전용 ticket11 lab에서 `2 진단 응답 😀`를 실제 제출해 delivered를 확인했다. 실행 `run-3984e594-e0df-48ce-8218-affb2351aa59`, session `1791547887072_elo68`의 실제 수집 묶음은 963관측, 1,684,091바이트다. 모델은 RED/BLUE를 다시 요구했고 자연 완료하지 않았다. 해당 소유 실행은 공개 SDK stop으로 CLI·자식 종료를 확인했고 stopped로 기록했다. 이 기록을 offline replayAll로 다시 해석한 이벤트·최종 snapshot 차이는 0이다. 모델의 자연 완료 성공으로 세지 않는다.

존재하지 않는 SSH 실행 파일의 실제 실패는 2관측, 2,095바이트로 수집했고 connecting→ssh-unavailable/disconnected를 offline에서 같은 시각·ID·이벤트로 재현했다. eventDifferences 0, snapshotMatches true였다. 원격 인증 복사본은 원격 내부에서만 준비했으며 그 내용을 수집하거나 출력하지 않았다.

Windows Chrome에서도 별도의 실제 BLUE 응답을 delivered로 확인하고 `SDK_DIAGNOSTIC:BLUE`를 수집했다. 673관측, 1,080,549바이트의 묶음은 진단 종료 후에도 원격 TUI 실행이 살아 있었으며, offline에서 당시 running·delivered와 동일 ID·시각을 복원했다. 이벤트 차이 0, snapshot 일치, truncated false였다. 재생 화면은 `재생 · 기록 당시 connected`를 명시하고 실시간 조작을 잠갔다. [실제 재생 화면](evidence/ticket-11-replay.jpg).

이 질문/응답 및 브라우저 대조는 #7/#8을 포함한 decoder에서 수행했다. 이후 #10의 historySync 필드를 추가한 decoder는 이전 비교 sidecar에 없던 필드를 차이로 표시한다. expected state를 주입하거나 차이를 제거하지 않는다. 최신 #10 통합 decoder에서도 모델·입력을 실행하지 않고 같은 소유 실행에 새 수집을 시작한 뒤 read-only attach했다. `run-96a7a94c-fc0d-46e7-be22-79594895b8a9`, session `1791548132816_6xzwp`의 stopped 상태와 historySync current true를 392관측, 380,951바이트로 수집했고 offline 이벤트 차이 0, snapshot 일치를 다시 확인했다. 원시 history-failure·부분 JSON·완전 복구·응답 receipt의 공통 decoder 대조 시험도 통과했다.

`npm test`는 SDK 공개 API를 통해 수집 한도·정확한 파일 바이트 합계·활성 묶음 보호·소유 묶음 정리·사용자 파일 보존·저장 실패·sidecar 변조 독립성을 검증한다. 회사 fork의 실제 동작 재검증과 반출용 가림·내보내기는 후속 범위다.
