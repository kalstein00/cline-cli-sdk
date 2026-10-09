# 독립 SDK와 기록 재생 (#2)

Node.js 22 이상에서 `@cline-cli-sdk/sdk`를 사용한다. SDK는 DART·Electron·UI 프레임워크에 의존하지 않는다. 이번 단계는 공개 Cline 3.0.69의 검토한 관측 구간을 재생한다. 실제 SSH 연결, 모델 호출, 질문 응답 전송, 실행 복구·중단·재개, 회사 fork 호환성은 이 단계에서 지원하지 않는다.

## 실행

저장소 루트에서 실행한다. Windows PowerShell과 Node.js 24.16.0에서 검증했다.

```powershell
npm ci
npm test
npm run example:node
npm run example:web
```

웹 예제는 `http://127.0.0.1:4173`에만 바인딩한다. `CLINE_SDK_PORT`로 포트를 바꿀 수 있다. Node 예제와 웹 서버는 같은 패키지의 공개 API를 호출하며, 브라우저는 서버가 전달하는 공개 snapshot·이벤트만 표시한다. 예제에는 CLI 파서나 일반 터미널 입력창이 없다.

독립 소비 앱에 설치할 배포물은 다음으로 만든다. 출력된 `.tgz`를 다른 Node 프로젝트에서 `npm install <절대경로.tgz>`로 설치한 뒤 같은 import를 사용할 수 있다.

```powershell
npm run build
npm pack --workspace @cline-cli-sdk/sdk --pack-destination $env:TEMP
```

```javascript
import { createClient } from '@cline-cli-sdk/sdk';
const sdk = createClient({ mode: 'replay' });
const unsubscribe = sdk.subscribe(event => console.log(event));
await sdk.openReplay(recording);
await sdk.replayAll();
console.log(sdk.snapshot());
unsubscribe();
sdk.close();
```

## 공개 계약

`openReplay(recording)`은 검증한 기록을 메모리로 복사하고 초기 snapshot을 반환한다. 잘못된 스키마·순서·터미널 크기는 기존 상태를 바꾸기 전에 `SdkError('invalid-recording')`로 거부한다. `nextObservation()`은 원시 관측 한 개를 해석하고, `replayAll()`은 남은 관측을 순서대로 해석한다. `snapshot()`과 구독 이벤트는 소비 앱이 수정해도 SDK 상태에 영향을 주지 않는 복사본이다. 마지막 관측 뒤 `nextObservation()`은 동일한 snapshot을 반환한다.

`respond({sessionId, executionId, interactionId, revision, requestId, answer})`는 응답 요청의 계약을 예약하며, 재생 모드에서는 항상 `replay-read-only`로 거부한다. 표시된 질문을 실제 CLI에 제출하거나 선택했다고 보고하지 않는다. `capabilities()`는 `replay: true`, `live: false`, `responses: false`, `companyCompatibility: 'unverified'`를 반환한다. `close()`는 재생 자원을 해제한다.

| 값 | 의미 |
| --- | --- |
| `sessionId` | 대화의 정체성. 재접속·새 실행과 구분한다. |
| `executionId` | 그 대화에서 특정 원격 실행의 정체성. 현재 fixture에는 비식별 ID만 있다. |
| `interaction.id` | 실행 중 특정 입력 단계의 정체성. 같은 문구가 다시 질문되면 새로운 ID다. |
| `requestId` | 소비 앱의 응답 제출 정체성. 이번 재생 이벤트는 제출이 없어 `null`이다. |
| `revision` | 해당 재생 열기 이후 정규화 메시지·상호작용 변경 순서. 새 기록을 열면 0으로 초기화한다. 재생 위치·자원 close 자체는 이벤트를 생성하지 않는다. |
| `interaction.revision` | 현재 질문이 생성된 revision. 응답 대상을 다른 상태 변경과 구분한다. |

이벤트는 `type`, 관련 식별자, `revision`, 원시 `observationSeq`, `observedAt`, 정규화 `payload`를 제공한다. `message.upsert` payload는 메시지 `{id, role, text}`이며, 같은 ID의 새 내용은 기존 메시지를 갱신한다. `interaction.changed` payload는 질문·미지원 상태 또는 닫힌 질문을 나타내는 `null`이다. `state.changed`는 후속 실행·연결 기능에서 사용할 예약 종류다. 구독은 `openReplay` 이전에 설치한다. 소비 앱은 새 기록을 연 뒤 반환되는 snapshot으로 기존 화면을 교체한다.

연결 상태는 `replay | closed | connecting | connected | disconnected`, 실행 상태는 `unknown | running | awaiting-input | completed | stopped | failed`, 상호작용 상태는 `awaiting-response | submitting | delivered | delivery-unknown | unsupported`로 분리한다. 이번 단계는 연결 `replay/closed`, 실행 `unknown/awaiting-input`, 상호작용 `awaiting-response/unsupported`만 관측 근거로 제공한다. 기록 종료·완료 문구·history 메시지를 작업 성공으로 추정하지 않는다. 질문이 화면에서 닫히면 실행은 `unknown`으로 돌아간다. 다른 상태의 enum 존재는 해당 기능의 구현을 의미하지 않는다.

## 원시 fixture

`Recording`의 스키마는 `schemaVersion: 1`, CLI 이름·버전·프로필, 터미널 행·열, 세션·실행 ID, provenance, 순서가 증가하는 observations다. 관측은 `kind: 'pty' | 'history'`, `seq`, `observedAt`, `dataBase64`, 선택적인 원래 `elapsedNs`를 갖는다. PTY는 ANSI와 UTF-8 수신 바이트를 그대로 입력한다. history는 CLI의 version 1 messages JSON envelope 바이트를 입력한다. SDK가 JSON을 해석해 text content만 정규화한다. tool·system prompt를 메시지로 표시하지 않는다. 완료되지 않은 JSON은 `invalid-history`를 보고하며 마지막 정상 대화를 유지한다. 다음 정상 관측은 같은 메시지 ID로 갱신할 수 있다.

| 파일 | 원시 관측 출처 | 검토 범위 |
| --- | --- | --- |
| `fixtures/message.json` | `20261009/logs/choice-live/frames.ndjson` seq 30 | 실제 최종 assistant text `CHOSEN:BLUE`만 남긴 messages envelope. |
| `fixtures/question.json` | 같은 기록 seq 16, 18 | 실제 follow-up 질문·RED/BLUE 선택지 및 ANSI 바이트. |
| `fixtures/unsupported.json` | 같은 기록 seq 12 | 실제 ask_question 승인 화면. #2에서는 승인을 구현하지 않아 미지원으로 표시. |

provenance에는 전체 로컬 원본의 SHA-256, 상대 출처, 검토 설명, 변환 목록을 남긴다. fixture는 완료된 전체 실행이 아니라 선택 구간이므로 `complete: false`, `truncated: true`다. 세션·실행·메시지 식별자는 비식별화했고, history의 인증·모델·provider·경로·system_prompt·metrics·사용자 컨텍스트를 제외했다. PTY 구간에는 통제된 질문과 색상만 있다. 원본 파일은 커밋하거나 수정하지 않았다. 원래 상대 elapsedNs를 보존하며 `observedAt`은 고정 재생 시각으로 정규화했으므로 실제 캡처 시각으로 해석하지 않는다. SHA는 출처 식별이며 SDK 해석을 대신하는 수용 검사가 아니다.

터미널 화면 복원에는 `@xterm/headless`의 실제 터미널 에뮬레이터를 사용한다. ANSI 제거로 대체하지 않는다. 현재 커서와 입력 footer를 확인해 scrollback에 남은 과거 질문을 현재 질문으로 재사용하지 않는다. 같은 활성 질문의 반복 관측은 중복 이벤트를 만들지 않으며, 닫힌 뒤 같은 질문이 다시 나타나면 새로운 ID를 만든다. 미확인 프로필과 알 수 없는 입력 프롬프트는 조작 불가 상태다.

## 검증과 남은 수용

SDK 공개 API 계약 시험 9개는 실제 raw fixture 해석, 메시지 갱신, 불완전 JSON 보존, 같은 질문의 중복 및 새 단계 식별, 미지원 프로필, 원격 입력 차단, 입력 순서 검증을 확인한다. 한글과 화면 덮어쓰기·매 바이트 분할은 통제된 fault injection이며 실제 회사 관측으로 주장하지 않는다. 외부 프로세스 실행·fetch 경계에 실패 감시를 설치한 재생 시험에서도 호출이 없다. 별도 임시 Node 프로젝트에 packed `.tgz`를 설치해 공개 API로 질문·RED/BLUE 선택지를 해석하는 독립 소비도 통과했다.

2026-10-09 Windows Chrome에서 CUA로 별도 화면 검증했다. 정상 메시지 버튼은 `CHOSEN:BLUE`를 표시했고, 선택 질문은 `Choose test color.`와 disabled `RED`/`BLUE`, `replay`/`awaiting-input` 상태를 표시했다. 미지원 승인 화면은 `unsupported`/`unknown` 상태이며 응답 컨트롤이 없다. 선택·잘림 기록임을 화면에 표시했다. [실제 질문 화면](evidence/ticket-2-question.jpg).

실제 SSH/모델/CLI 질문 왕복, 라이브 승인·자유 입력·TUI, 실행 유지·재연결·중단·재개, SDK 진단 묶음 수집 왕복과 회사 CLI 호환성은 후속 티켓의 수용 범위다. 이번 화면 증거는 재생 모드에 한정된다.
