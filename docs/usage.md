# 소비 앱 시작과 현재 SDK 계약

이 문서는 현재 구현의 진입점이다. 과거 단계의 [#2 기록 재생 설명](sdk.md)은 당시 수용 증거이며 현재 기능 목록을 대신하지 않는다. SDK는 Node.js 22 이상에서 동작하고 DART·Electron·UI 프레임워크에 의존하지 않는다. 공개 Cline 3.0.69의 검증한 executable SHA-256과 readline/TUI 어댑터를 사용한다. 회사 fork 호환성은 미검증이다.

## 시작

```powershell
npm ci
npm test
npm run example:web
```

브라우저는 `http://127.0.0.1:4173`을 연다. `CLINE_SDK_PORT`로 포트를 변경한다. 예제는 SDK 공개 API를 사용하는 Node 서버와 브라우저 UI다. 예제에 별도 CLI 파서나 일반 터미널 입력 우회가 없다. [SSH·Linux·Python·tmux·CLI 준비](live.md)를 확인하고 SSH alias, 고정 CLI 경로, 작업 디렉터리와 격리 dataDir를 입력한다. 인증은 원격 내부에서 소유자 전용으로 준비하며 SDK가 자격 증명을 브라우저에 보내거나 진단 묶음에 수집하지 않는다.

독립 소비 앱에는 packed npm 패키지를 설치한다. 원격 Python helper도 포함된다.

```powershell
npm run build
npm pack --workspace @cline-cli-sdk/sdk --pack-destination $env:TEMP
# 소비 앱 디렉터리에서 npm install <출력된 tgz의 절대 경로>
```

```js
import {createClient} from '@cline-cli-sdk/sdk';
const sdk=createClient({mode:'live',connection:{host:'your-ssh-alias',cliPath:'/absolute/pinned/cline',remoteRoot:'/owner-only/sdk-control'}});
sdk.subscribe(event=>updateFromEvent(event));
const environment=await sdk.connect();
if(!environment.ready)throw new Error(environment.problems.join(', '));
await sdk.start({cwd:'/remote/workspace',dataDir:'/isolated/cline-data',terminalMode:'tui',prompt:'Your task'});
const snapshot=await sdk.refresh();
```

정상 모드에서는 원시 출력·대화를 영구적으로 로컬에 복제하지 않는다. 예제는 연결 설정·관리 실행 식별자를 저장하고 대화는 메모리에서 표시한다. 원격 CLI의 실제 history와 관리 프로세스 증거로 재연결한다. 진단 기록은 아래의 명시적 opt-in이다.

## 상태와 조작

`snapshot()`은 복사본이며 연결·실행·현재 상호작용·응답 전달을 구분한다. `sessionId`는 대화, `executionId`는 실행, `interaction.id`는 현재 입력 단계, `requestId`는 소비 앱의 요청 정체성이다. 질문을 제출할 때 현재 snapshot revision을 함께 보낸다. 동일 requestId와 동일 요청은 중복 입력을 보내지 않으며, 같은 질문의 경합 요청·오래된 단계·다른 session/run은 차단한다.

```js
const s=sdk.snapshot();
const result=await sdk.respond({sessionId:s.sessionId,executionId:s.executionId,
  interactionId:s.interaction.id,revision:s.revision,requestId:crypto.randomUUID(),
  answer:s.interaction.choices[0]});
```

전체 승인 인자를 표시하고 `capabilities()`와 현재 `interaction.responseKinds`를 함께 확인한다. [승인·거절·선택](interactions.md), [TUI·자유 응답과 제한](text.md)을 따른다. `delivered`는 CLI 수신 확인이며 작업 성공을 뜻하지 않는다. submitting·delivery-unknown·unsupported에서는 응답을 잠근다. SSH/FIFO write만으로 delivered를 추정하지 않는다.

| 공개 메서드 | 동작과 근거 |
| --- | --- |
| `preflight()`, `connect()` | 환경·CLI fingerprint 확인. 미지원 프로필은 시작/조작을 막는다. |
| `start(request)` | 새 관리 실행. 선택적인 `retryLimit:1..10`만 CLI 기본값을 변경한다. |
| `refresh()` | 실제 history·현재 터미널·프로세스·입력 receipt를 다시 관측한다. |
| `disconnect()` | 로컬 연결 해제. 원격 작업 중단을 뜻하지 않는다. |
| `listManagedExecutions()`, `attach(id)` | SDK가 시작한 실행만 조회·복원한다. [재연결](reconnect.md). |
| `reconfirmDelivery()` | 불명 요청의 원래 receipt·도구 결과·단계를 다시 판정한다. 입력을 재전송하지 않는다. [전달 복구](delivery.md). |
| `stop({executionId,requestId})` | 소유권을 확인한 CLI와 추적한 자식 종료를 확인한다. `confirmed/unknown` 및 대상 identity 증거를 제공한다. [중단](stop.md). |
| `close()` | 로컬 자원을 해제한다. 원격 stop을 대신하지 않는다. |

이벤트는 type·관련 식별자·revision·observationSeq·observedAt·payload를 제공한다. 메시지는 ID 기준 upsert이고 새 입력 단계는 별도 interaction ID다. 소비 앱은 구독 이벤트 뒤 최신 snapshot을 읽거나 refresh하며, 늦게 도착한 더 오래된 revision으로 화면을 덮어쓰지 않는다. 연결 불명·관측 누락·현재성 미확인은 정상 완료로 표시하지 않는다. 재생 UI는 기록 당시의 `connected`를 보여줄 수 있지만 `mode:'replay'`, `responses:false`이며 실제 연결을 만들지 않는다.

## 진단과 오프라인 비교

[진단 기록 계약·한도·실측](diagnostics.md)을 따른다. SDK 생성 뒤 connect 전에 시작하면 연결부터 전체 입력을 수집한다. 진행 중 시작한 기록은 앞 관측 누락을 표시하는 부분 기록이며 동일 이벤트를 완전히 대조할 수 있다고 주장하지 않는다.

```js
await sdk.startDiagnostics({directory:'/local/review-directory'});
// connect → start → refresh/respond/stop 등 실제 공개 API 작업
console.log(sdk.diagnostics());
const saved=await sdk.stopDiagnostics();
```

```js
import {readDiagnostic,compareDiagnostic} from '@cline-cli-sdk/sdk';
const bundle=await readDiagnostic(saved.path);
const replay=createClient({mode:'replay'}),events=[];
replay.subscribe(event=>events.push(event));
await replay.openReplay(bundle.recording);
await replay.replayAll();
console.log(compareDiagnostic(bundle,events,replay.snapshot()));
```

같은 decoder가 원시 관측을 해석한다. 저장된 정규화 이벤트·snapshot은 비교 sidecar이고 재생 입력으로 주입하지 않는다. 오프라인 재생은 SSH·모델·원격 입력을 실행하지 않는다. 회사에서 가져온 원시 기록을 재생해 수정한 사실과 실제 회사 CLI에서 다시 확인한 사실을 구분한다.
