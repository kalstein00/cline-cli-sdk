# 독립 챗봇 소비 앱 수용

## #21 첫 요청과 답변

2026-10-11 Windows Chrome의 실제 화면에서, 저장소 밖 임시 디렉터리에 packed SDK를 설치한 독립 예제를 실행했다. Node 24.16.0 → OpenSSH `wsl` → Ubuntu-24.04의 고정 공개 Cline 3.0.69를 사용했다. 실행 파일 SHA-256은 `8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032`와 일치했다. 시험 소유 작업/관리/데이터 디렉터리와 원격 소유자 전용 인증 사본을 사용했다.

브라우저에서 연결 설정을 입력하고 첫 메시지 `Reply exactly CHAT_FIRST_READY. Do not call any tools.`를 전송했다. 같은 화면의 assistant 답변 `CHAT_FIRST_READY`와 SDK snapshot을 확인했다. SID는 `1791709018504_x6bgo`, EID는 `run-8d292c38-c13d-4ad5-a96b-c0cd1e75d6d7`이다. TUI는 살아 있으므로 화면은 `running`으로 표시하며 답변 수신을 실행 종료로 처리하지 않았다.

- [실제 독립 소비 앱 화면](evidence/chat/first-conversation.png)
- [실측 요약](evidence/chat/first-conversation.json)

SDK build와 예제 서버의 JS typecheck가 통과했다. 공개 SDK live 시험 8개와 실제 Chrome를 사용하는 브라우저 회귀 4개가 통과했다. 브라우저 회귀는 외부 OpenSSH 경계만 통제해 첫 요청, 메시지 중복 방지와 초안 유지, HTTP 응답 상실, 50,000자 한글 요청, 잘못된 launch identity의 불명 상태 보존을 검사한다. 이 통제된 시험과 앞의 실제 모델 왕복을 구분한다. 전체 시험은 티켓 체인의 최종 단계에서 한 번 실행한다.

두 축 리뷰에서 HTTP 실패를 미제출로 판단하던 UI, SDK 계약보다 작은 HTTP 본문 한도, launch identity 오류의 미제출 오판을 수정했다. 브라우저는 원래 요청 ID를 유지하며, 서버는 명시적인 전송 전 검증 오류만 미제출로 처리한다. 실행 예약 후 identity가 확인되지 않으면 브라우저 재로드 뒤에도 새 연결·전송을 차단한다.

재현: `npm ci`, `npm run build`, `npx tsc -p examples/chat/tsconfig.json`, `node --test tests/chat-browser.test.mjs tests/live.test.mjs`. 독립 설치는 SDK를 pack한 `.tgz`를 저장소 밖으로 가져가 예제 패키지에 설치하고 `npm start`를 실행한다. 화면에는 SSH 별칭, 고정 CLI 경로, 시험 소유 관리/작업/격리 데이터 경로를 입력한다.

현재 첫 요청·답변만 수용했다. 후속 메시지·질문 조작·대화 목록·단절 복구·중단/재개는 각각 후속 티켓에서 구현·검증한다. 회사 CLI 호환성은 미검증이다. 기존 미커밋 자료와 사용자 전역 CLI/인증 설정은 변경하지 않았다.

## #22 후속 입력 준비 상태

Windows → SSH → 고정 공개 CLI에서 첫 요청, 도구 승인, 8초 Python 도구 실행(결과 `123`), `CHAT_READY_QUESTION` 선택 질문, `CHAT_READY_DONE` 이후 빈 Act composer를 실제 관찰했다. 같은 SID/EID의 살아 있는 CLI와 manifest `idle`을 확인했고 실행 상태는 `running`으로 유지했다. 검토한 원시 관찰은 계정/소유 경로/SID/EID를 치환한 `fixtures/chat/readiness.json`에 저장했다. 도구 실행·질문 단계의 process/phase/history/PTY 원시 관찰을 공개 SDK 재생으로 검증했다.

`Snapshot.messageInput`은 `{ready, reason, maxBytes:112}`를 제공한다. 정확한 3.0.69 TUI 프로필, 40×120 화면, 최신 기록, 살아 있는 동일 identity/supervisor, manifest `idle`, 자식 프로세스·미완료 도구·질문·이전 불명 요청 부재, 관찰된 빈 focused composer/hash를 함께 요구한다. 근거가 없으면 활성화하지 않는다. 구형 기록에 terminal witness가 없으면 필드는 없으며 소비자는 이를 확인 중으로 취급한다. replay의 준비 상태는 기록 해석이며 `capabilities().sendMessage`는 항상 false다. 전송 API는 #23에서 추가한다.

SDK build와 예제 typecheck 통과. 공개 API 준비 상태 10개, 브라우저 6개, resume/diagnostic 회귀 9개 통과. 생성·도구·질문 대기, stale history, 단절, 프로필/identity 불명은 각각 차단 이유를 제공한다. 준비 상태 변화는 revision과 `state.changed`로 전달한다. 기존 기록의 질문/응답 및 resume 진단의 live/replay 비교도 통과했다. 실제 브라우저 근거는 `evidence/chat/readiness-browser.{png,json}`, 실제 단계 요약은 `evidence/chat/readiness.json`에 기록한다.

## #23 같은 실행에 후속 메시지 전송

공개 `sendMessage({sessionId,executionId,revision,requestId,text})`와 `SendMessageRequest`/`MessageDelivery` 타입을 추가했다. 같은 ID·같은 요청은 기존 promise/결과로 반환하며, 충돌·오래된 revision·다른 대상·동시 입력을 전송 전에 거부한다. 원격 ledger에 history count/마지막 message ID와 원문 digest를 먼저 예약한다. grapheme 경계 청크의 정확한 composer echo 후에만 별도 Enter를 쓰고, 예약 경계 뒤 새 user 메시지 하나의 ID/digest로 delivered를 판정한다. CLI/SID/EID는 바꾸지 않는다. 전달은 답변 완료와 다르며 새 user 메시지만 관찰된 구간은 입력 준비로 취급하지 않는다.

Windows Chrome → SDK → 고정 공개 CLI에서 첫 메시지 뒤 네 번 왕복했다. 숫자 선행 `2 한글 😀 café: Reply exactly CHAT_FOLLOWUP_ONE. No tools.`, 서로 다른 두 번째 요청, 동일 문구 요청 두 번을 그대로 전송했다. 같은 SID `1791710324301_qfpa1`/EID `run-247873e4-d528-4473-b7a1-564c52c81335`에서 각 요청이 서로 다른 새 message ID에 연결됐다. 중복 클릭에서도 원격 쓰기는 한 번이었다. `evidence/chat/followup-browser.{png,json}`에 실제 화면과 결과가 있다.

별도 실제 공개 SDK 왕복 네 번을 진단 수집하고 정상 finalize했다. 원시 재생/비교는 eventDifferences 0, snapshotMatches true였다(`evidence/chat/followup-api.json`). 검토한 비식별화 기록은 `fixtures/chat/followup.json`이며 공개 재생 시험에서 같은 문구의 서로 다른 user ID와 전달 상태를 복원한다. 브라우저 측 강제 쉘 종료로 미완료인 진단 bundle은 수용 근거에서 제외했다.

SDK build·예제 typecheck 통과. 공개 API의 제한/중복/충돌/동시/대상/새 경계/echo 상실/Enter 후 관찰 상실/진단 비교/실측 재생, 실제 Chrome 회귀와 기존 resume·diagnostic focused 검사 통과. 브라우저는 UTF-8 112바이트 단일 행 제한을 안내하고 잘못된 원문/초안을 유지한다. 동일 문구의 과거 메시지로 pending을 지우지 않고 원격 message ID에 연결한다. 불명 전달은 자동 재전송·다른 ID 우회를 차단한다. packed SDK의 공개 d.ts와 remote/message.py 포함도 확인했다. 새 클라이언트에서 durable 요청 복원은 #26의 수용 범위다.

## #24 질문 응답과 승인·거절

기존 SDK 공개 `respond`를 소비 앱에 연결했다. 현재 SID/EID/interaction ID/snapshot revision/request ID를 결합해 선택을 전달한다. 도구명과 전체 인자는 textContent/JSON으로 표시하고 승인·거절을 직접 선택한다. SDK `responseKinds`와 capability가 자유 응답을 허용할 때만 하단 입력창을 질문 응답 모드로 사용한다(UTF-8 1,024바이트, printable 단일 행, grapheme 64바이트). 일반 후속 전송은 질문/승인 중 차단하며, stale history·제출 중·불명 응답·지원하지 않는 화면도 잠근다. 같은 interaction 갱신은 같은 카드로 유지하고 새 단계는 새 카드다.

실제 Windows Chrome → WSL에서 `printf APPROVED24 > approved24.txt`를 승인하고 `CHAT_CHOICE`에 BLUE를 선택했다. 같은 대화의 다음 요청에서 `touch denied24.txt`를 거절한 뒤 `CHAT_FREE`에 `2 한글 응답 😀 café`를 입력했다. 네 응답 모두 SDK `delivered`이며, SID `1791711007010_jz5fx`/EID `run-c19f2999-5fec-4bb3-95e6-48cf8152d61b`를 유지했다. 원격 history를 읽기 전용으로 대조해 승인 tool result 성공, BLUE, 거절로 실행되지 않은 tool result, 정확한 자유 응답을 확인했다. 승인 파일 내용은 APPROVED24이며 거절 파일은 없었다. `evidence/chat/interactions-browser.{png,json}` 및 `interactions-tool-results.json`에 근거가 있다.

실제 검증 중 주기적 상태 확인과 클릭이 겹쳐 `operation-busy`로 미제출되는 경우를 확인했다. 상태 확인 중에도 화면을 잠그고 완료 후 다시 게시하도록 수정했다. 이 거부를 전달 완료로 표시하지 않으며 원문을 보존한다. 화면 복원 중 일시적인 미지원 카드는 지원 질문으로 확정되면 정리한다. SDK build/예제 typecheck 및 public SDK live/text/Chrome focused 25개가 통과했다. 브라우저는 카드 중복, 자유 응답 모드, 전체 승인 인자, 일반 전송 차단, HTTP 관측 상실 후 선택·응답 잠금을 검사했다. 전체 suite는 최종 티켓에서 실행한다.

## #25 관리 대화 목록과 전환

공개 `listManagedExecutions`만 목록으로 사용하며 SID가 없으면 EID로 임시 그룹을 만든다. SID 확인 후 같은 그룹으로 표시하되 각 EID의 선택 버튼은 유지한다. 제목은 현재 선택의 첫 user 메시지 또는 식별자이며 목록의 다른 history를 미리 읽지 않는다. 선택/새 대화는 이전 구독과 클라이언트를 close하고 새 공개 클라이언트로 connect/attach한다. 원격 stop은 호출하지 않는다. 주기적 refresh와 경합하는 선택은 그 읽기가 끝난 뒤 진행한다.

generation 증가 시 이전 메시지·질문 카드를 정리하고 대화별 메모리 초안을 복원한다. 지난 generation의 snapshot·HTTP 결과·오류·입력은 무시하거나 거부한다. submitting/불명 전달 중에는 선택과 새 대화를 잠근다. localStorage에는 연결의 최소 설정과 마지막 EID만 남기며 키 경로·history·초안·PTY는 저장하지 않는다.

실제 Windows Chrome → WSL에서 CHAT_LIST_A/B 두 대화를 만들고 각각 새 클라이언트로 전환하여 서로 다른 SID/EID와 각 초안을 확인했다(`evidence/chat/conversations-browser.{json,png}`). 원격 실행은 살아 있었다. Chrome 통제 시험으로 늦은 이전 snapshot 주입, 오래된 대상 입력 거부, A/B 메시지와 초안 분리를 확인했다. 기존 Chrome 9개와 새 선택 시험, 예제 typecheck 통과. durable 불명 전달의 새 클라이언트 복원과 재시작은 #26에서 검증한다.

## #26 단절·재시작 후 복원

`reconfirmDelivery()`는 후속 composer 예약도 재대조한다. 새 클라이언트는 최소 원격 ledger의 SID/EID/request ID/digest/history count/마지막 ID와 수신 witness를 원시 receipt로 복원한다. 원래 history 경계 뒤 같은 원문의 새 user ID를 확인해야 delivered다. 미확정 예약·ledger 상실은 불명 상태로 유지하고 새 ID 입력을 막는다. 재대조는 원문·Enter·승인을 쓰지 않으며 알려진 같은 요청을 새 클라이언트에서 확인해도 입력하지 않는다. 진행 중인 전송과 재대조는 분리한다.

연결 해제/재연결/전달 상태 다시 확인 버튼을 추가했다. 브라우저와 서버가 단절되면 응답 버튼도 잠근다. Node 프로세스별 server ID와 generation을 함께 결합하여 재시작 후 이전 요청이 새 서버를 조작하지 못하게 한다. 브라우저에 저장된 마지막 EID를 같은 관리 목록에서 찾은 뒤 공개 attach로 복원한다. 새 서버로 연결할 때 로컬 pending 원문은 재전송하지 않는다.

실제 Windows Chrome → WSL에서 살아 있는 Cline의 CHAT_RECONNECT 질문을 기다린 뒤 연결 해제·재연결, 별도 임시 프로필의 Chrome 프로세스 종료·재시작, Node 서버 프로세스 종료·재시작을 차례로 수행했다. ledger 보완 뒤 새 실제 실행으로 재검증했으며 모두 SID `1791712635349_d1vk1`/EID `run-f097419b-d703-4e5c-b0fc-317f50b16751`, 질문 ID와 메시지가 같았고 새 CLI·user 메시지·응답은 없었다(`evidence/chat/reconnect-browser.{json,png}`). 이는 SSH/로컬 소비자 복구 근거이며 원격 머신 재부팅 근거는 아니다.

통제된 외부 SSH 장애 시험에서는 후속 Enter 뒤 관측 상실과 질문 제출 뒤 acknowledgment 상실을 각각 새 공개 SDK 클라이언트로 복원했다. 새 ID 우회가 거부됐고 재대조 후 원래 수신 근거로 확정했으며 원격 입력 횟수는 증가하지 않았다. ledger 상실/부분 JSON에서 불명 상태·마지막 정상 기록/current=false를 유지하고 정상 재읽기 후 수렴했다. 새 클라이언트 복원 원시 진단의 public replay 비교는 eventDifferences 0, snapshotMatches true였다. SDK build·예제 typecheck, 공개 API/재연결/history/질문/진단 focused 27개와 Chrome 복원·선택 경계 3개 통과. 실제 수신 직후 SSH 단절은 강제하지 않았으며 해당 경계는 통제 장애 근거다.

#26 리뷰 보완: 같은 클라이언트에서 재대조로 확정된 동일 요청은 과거 실패 promise 대신 현재 delivered receipt를 반환한다. 새 원격 실행은 입력 ledger를 명시적으로 초기화하며, missing/corrupt ledger를 정상적인 빈 ledger로 취급하지 않는다. 공개 Snapshot.inputControl.current=false 및 capability/준비 상태로 최초 attach부터 후속 입력과 질문 응답을 잠근다. 원격 예약도 누락 ledger를 자동 재생성하지 않는다. 구형 실행의 ledger가 처음부터 없는 경우 안전한 입력 근거가 없으므로 읽기/중단만 허용한다. 두 보완 경계의 공개 API 회귀와 기존 focused 검증을 통과했다.

## #27 명시적 중단과 종료 대화 재개

작업 중단은 연결 해제와 별도 버튼이며 현재 SID/EID/request ID에 결합한다. SDK stop의 stopping/confirmed/unknown을 표시하고, CLI·추적 자식·supervisor 종료 근거가 없는 경우 성공으로 표시하지 않는다. 기록은 유지한다. 종료가 확인되고 공개 resume capability가 있는 대화에서는 입력창이 `대화 재개하여 보내기`로 바뀐다. 살아 있는 실행은 sendMessage, 종료 확인 실행은 resume를 사용하며 자동 stop→resume는 없다. 재개도 UTF-8 112바이트의 printable 한 줄이며 새 EID를 같은 SID 그룹에 개별 버튼으로 추가한다.

실제 공개 SDK readline start의 정상 종료(exitCode 0) 대화를 브라우저 목록에서 선택해 NORMAL_RESUMED27로 재개했다. SID `1791713491678_f1i9q`를 유지하며 EID `run-ce0e41fa-e98a-4fc4-a0a9-54338d88c6ff`에서 `run-9f504927-5b6b-4745-9949-2673f880d6b8`로 바뀌었다. 별도 브라우저 TUI 대화에서 BEFORE_STOP27 답변 뒤 명시적 stop을 확인하고 STOPPED_RESUMED27로 재개했다. SID `1791713552674_qicb9`에서 `run-dd49efd8-063e-4b3e-acbe-49a851555f9c` → `run-4c073ed1-7cc9-4f0b-98ef-9367a686ac8a`였다. 두 요청은 `2 한글 😀:`로 시작하며 SDK delivered와 정확한 답변, 이전 message ID 보존을 확인했다. 중복 클릭은 실행을 반복 생성하지 않았다(`evidence/chat/stop-resume-browser.{json,png}`).

원격 meta/ownership/proc/history를 읽기 전용으로 대조해 이전 CLI와 자식 종료, 같은 SID·새 EID, 원래 history 경계 뒤 정확한 digest의 user 메시지를 확인했다(`stop-resume-remote.json`). 해당 두 재개 실행은 공개 SDK stop으로 confirmed 정리했고 대화 기록은 보존했다(`stop-resume-cleanup.json`). 원격 근거 파일의 마지막 PID 확인은 이 정리 뒤 수행했다. 원본 provider와 다른 사용자 실행은 변경하지 않았다.

실제 초기 재개 시험에서 composer가 다시 그려져 첫 입력이 거부되는 경우를 불명으로 처리했고 자동 재전송하지 않았다. 첫 쓰기 전 이전 기록과 빈 composer/hash가 연속한 bounded refresh에서 유지되는 것을 요구하도록 보강한 뒤 새 시험 대화에서 정상·중단 재개를 재검증했다. stop/resume과 주기적 읽기 경합도 읽기 완료 뒤 대상/종료를 재검사한다. 오래된 대상·중복 재개·불명 echo 및 실제 원시 재생을 포함한 공개 SDK 중단/재개 11개, Chrome 중단 confirmed/unknown·기록 보존·112바이트·재연결 3개와 typecheck/build 통과. 전체 suite는 #28에서 한 번 실행한다.

## #28 저장소 밖 독립 설치와 전체 수용

2026-10-11 Node 24.16.0 / 실제 Windows Chrome / OpenSSH `wsl` / Ubuntu-24.04 / 고정 공개 Cline 3.0.69 조합을 수용했다. 실행 파일 SHA-256은 위 단계의 `8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032`와 일치한다. SDK를 새로 build·pack하고 저장소 밖 임시 프로젝트에 예제의 여섯 파일과 `.tgz`만 복사했다. 설치된 SDK는 symlink가 아닌 해당 프로젝트의 node_modules이며 예제 자체의 `npm start`로 실행했다. 설치·파일 목록·패키지 digest는 `evidence/chat/independent-installation.json`에 기록한다.

실제 독립 앱에서 첫 요청의 `printf APPROVED28 > approved28.txt`를 승인하고 선택 질문에 BLUE로 답했다. 첫 후속 요청의 `touch denied28.txt`는 거절하고 자유 응답 `2 한글 응답 😀 café`를 보냈다. 두 번째 후속 요청 `2 한글 😀 café: Reply exactly CHAT_FOLLOWUP28. No tools.`의 원문·답변·delivered를 확인했다. 이 경로는 같은 SID/EID를 유지했다. 같은 문구를 별도 요청으로 두 번 보낸 결과는 다른 user message ID에 각각 연결됐다.

대기 질문에서 연결 해제/재연결, Chrome 프로세스 재시작, Node 서버 프로세스 재시작을 수행했다. SID/EID·질문 ID·전체 메시지가 같고 입력이나 CLI를 반복 생성하지 않았다. 두 번째 대화를 만들고 각 대화의 메모리 초안을 유지하며 전환했다. 첫 대화 질문에 답한 후 명시적으로 중단하여 SDK confirmed를 확인했고, 숫자·한글·emoji 재개 요청에 같은 SID·새 EID·기존 메시지 보존·delivered와 CHAT_RESUMED28 답변을 확인했다. 실제 화면/SDK 결과는 `independent-browser.{json,png}`, 읽기 전용 원격 history/ledger/프로세스와 승인 파일·거절 파일 대조는 `independent-remote.json`에 있다.

추가로 독립 예제의 시작 명령에 Node filesystem permission을 적용해 예제 디렉터리만 읽도록 했다. 저장소 README 읽기 probe는 ERR_ACCESS_DENIED였고, 그 조건에서 공개 connect/attach로 재개 대화를 읽고 새 대화 첫 요청과 두 후속 요청을 실제 왕복했다. SSH 프로세스 실행은 이 SDK의 정상 경로이므로 child-process 권한은 허용했다. 이는 Node 소비 앱의 저장소 소스 읽기 차단 검증이며 외부 SSH 프로세스의 전체 OS sandbox를 주장하지 않는다. 원래 예제의 기본 npm start 실행과 이 추가 제한 검증을 구분한다.

전체 `npm test`는 기능 체인 종료 후 한 번 실행하여 **130/130 통과**, 실패·skip 0이었다(약 61.64초). SDK build와 예제 JS typecheck도 통과했다. 전체 suite 이후 manifest 근거가 없을 때의 차단 이유를 process-unconfirmed로 명확히 하는 공개 API 회귀를 먼저 실패시킨 뒤 수정했고, readiness/sendMessage/resume focused 25개 및 예제 typecheck를 재검증했다. 이 추가 시험을 포함한 현재 시험 수는 131개이며 전체 suite를 다시 실행했다고 표현하지 않는다. 전체 suite는 기존 SDK public API 회귀, 새 후속 입력·ledger 복원, 진단 replay 비교와 Chrome 16개를 포함한다. 추가 Chrome 회귀로 IME Enter의 무전송, 여러 행 후속 입력의 HTTP 이전 거부/초안 유지, 기록 회복 중 읽는 위치와 초안 유지, 안전한 text 표시와 최소 localStorage를 확인했다. SDK 내부 함수/CSS 배치를 고정하지 않고 공개 SDK 및 브라우저 계약에서 관찰했다. 별도 실제 WSL FIFO→PTY 경계 시험 2개(네 입력 모드와 ledger 누락 fail-closed)는 #26에서 통과했으며 npm test에 포함된다고 표현하지 않는다.

### #20 수용 기준 연결

| AC | 담당 티켓 | 근거와 결과 |
| --- | --- | --- |
| 01 | #21, #28 | 별도 example:chat의 실제 화면·독립 npm start, 기존 example:web 유지. `first-conversation.png`, `independent-browser.png` — 통과 |
| 02 | #21, #28 | `examples/chat/server.mjs`는 설치한 SDK 공개 export만 import. 독립 파일 목록·symlink 없음·저장소 읽기 거부 조건 왕복 — 통과 |
| 03 | #22, #23, #28 | `followup-browser.json`, `independent-browser.json` first/send의 같은 SID/EID 및 delivered — 통과 |
| 04 | #23, #28 | 실제 숫자·한글·emoji와 동일 문구 두 번, 원격 ledger 경계/서로 다른 새 message ID — 통과 |
| 05 | #23, #27, #28 | 공개 API 제한 시험·Chrome byte 초과/여러 행의 전송 전 거부·초안 보존, UI/README 112바이트 — 통과 |
| 06 | #22, #26 | 실제 생성·도구·질문·idle 원시 기록 `fixtures/chat/readiness.json`; stale/미지원/identity/ledger 차단 public API 시험 — 통과 |
| 07 | #24, #28 | 실제 승인/거절/BLUE/자유 응답, `interactions-tool-results.json`, `independent-remote.json`; 거절 파일 없음 — 통과 |
| 08 | #21, #23, #27, #28 | 실제 더블클릭과 동일 요청 ID 공개 API 중복 검사, Chrome IME Enter의 무전송 — 통과 |
| 09 | #23, #26 | 외부 SSH 장애 주입의 Enter 뒤 상실/새 ID 차단/새 클라이언트 재대조 및 raw replay 비교, Chrome HTTP 상실. 실제 수신 직후 SSH 강제 단절은 미실측 — 통제 경계 통과 |
| 10 | #26, #28 | 실제 Chrome·Node 재시작 뒤 같은 질문/메시지/SID/EID 복원 — 통과 |
| 11 | #25, #28 | 실제 두 대화/초안 전환, Chrome 늦은 SSE/HTTP와 stale 대상 거부 — 통과 |
| 12 | #26, #27, #28 | 실제 disconnect 작업 유지, SDK confirmed stop, 정상 종료/명시적 중단의 same-SID/new-EID resume 및 history 보존 — 통과 |
| 13 | #21, #25, #26, #28 | 공개 history-sync 부분 JSON의 마지막 정상 기록 유지, Chrome ID 갱신/회복 상태·읽는 위치·초안·새 메시지 안내 — 통과 |
| 14 | #21, #25, #28 | 설정+EID만 localStorage, key path 제외; 앱 응답은 SDK 공개 상태, credentials 파일 미전달·opt-in 진단 — 통과 |
| 15 | #21, #28 | 새 packed SDK 독립 설치, 기본 npm start 전체 흐름 및 저장소 읽기 차단 Node 환경 첫 요청+두 후속 왕복 — 통과 |
| 16 | #22~#28 | npm test 130/130, 실제 공개 CLI/Chrome와 fixture·장애·raw replay를 각각 표시, 회사 fork 미검증 — 통과 |

요청한 AC-01~16에 담당과 근거를 연결했다. 실제 CLI에서 강제 수신 직후 단절은 수행하지 않아 AC-09의 해당 장애 타이밍 근거는 통제 SSH 시험이다. 원격 머신 재부팅과 회사 fork 수용은 이번 결과에 포함하지 않는다.

### 확인된 한계와 정리

첫 요청은 100,000 JavaScript 문자, 질문 자유 응답은 1,024 UTF-8 바이트의 별도 계약이다. 후속/재개는 112바이트 printable 단일 행이다. JSON 양방향 입력·회사 fork·장문 일반 챗봇 지원은 미검증/미지원이다. npm 공개 게시와 제품 앱 통합은 수행하지 않았다. 실행·연동·브라우저 계약 및 테스트 GUI 용도는 `examples/chat/README.md`에 있다.

## 버전 제한 제거와 첫 전송 버튼 회귀

2026-10-11 사용자 지시에 따라 CLI의 `--version` 조회와 버전 번호·특정 바이너리 해시를 통한 실행 허용 조건을 제거했다. 기존 4174 앱에서 다른 CLI 바이너리를 `unsupported-profile`로 처리하여 첫 전송 버튼이 비활성화되는 현상을 재현했다. preflight는 실행 파일과 필수 옵션을 확인하며 TUI·JSON·retry·resume는 각 옵션을 확인한다. 새 진단 기록은 `cline-readline`, `cline-tui`, `cline-json` 프로필과 조회하지 않은 버전 `unknown`을 기록한다. 이전 프로필 이름은 기록 재생을 위해 유지하되 버전 메타데이터로 입력을 허용·차단하지 않는다. 화면·기록·입력 echo·SID/EID·실행 파일 동일성·프로세스 소유권·전달 불명 검증은 유지한다.

실제 Windows → OpenSSH → WSL preflight에서 호출을 기록하는 시험용 CLI에는 `--help` 한 번만 실행됐고 버전 조회는 없었다. 현재 자동 발견 CLI도 `cliVersion:null`, `ready:true`였다. Windows Chrome의 별도 4188 앱에서 CLI 경로 자동 발견으로 연결한 뒤 첫 메시지 버튼 활성화와 초안 보존을 확인했다. 사용자 초안은 제출하지 않았다. 다른 버전·해시의 외부 SSH 응답으로 실제 소비 앱 첫 요청·답변·빈 composer를 검증했고, 버전이 다른 TUI 원시 기록의 질문·승인·준비 상태도 공개 재생으로 확인했다. 회사 CLI의 실제 왕복 검증을 수행했다는 의미는 아니다.

수정 후 `npm test` **139/139 통과**, 실패·skip 0, SDK build 및 예제 typecheck 통과. 연결 실패 시 첫 전송 비활성 사유를 하단에 표시하며 연결 전 화면에서 새 대화를 시작할 수 있다고 안내하지 않는다.

실제 재개 실행이 답변과 delivered를 만들었어도 공개 CLI manifest가 이전 PID를 유지하는 경우가 있었다. SDK는 manifest의 idle을 현재 실행 근거로 사용할 수 없어 후속 입력을 `process-unconfirmed`로 차단한다. 따라서 모든 재개 실행이 이후 sendMessage까지 준비된다고 주장하지 않는다. 이 경우의 다음 후속 지원은 별도 현재 실행의 작업 단계 근거가 필요하다. 초기 수용 스크립트의 불필요한 idle 대기는 timeout했고 재전송 없이 원래 delivered/답변을 읽기 전용 attach로 다시 확인했다. 성공한 재개 요청과 제한을 함께 보고한다.

시험 소유 실행의 공개 SDK stop 결과 및 별도 소유 identity 정리 결과는 `independent-cleanup.json`에 기록한다. 기존 대화/원격 history는 보존하고 격리 시험 인증 사본만 제거한다. supervisor 근거가 부족했던 이전 #25 실행의 SDK stop unknown은 confirmed로 바꾸지 않고, 정확한 소유 PID/startTime/bootId/UID 확인 뒤 별도 시험 정리를 구분한다. 원본 provider와 다른 사용자 프로세스는 변경하지 않는다. 부모 #20의 본문·라벨·상태는 변경하지 않는다.

옵션 누락에 따른 실행 전 `cli-option-unavailable`은 확정 미제출로 분류한다. 시작 예약·브라우저 pending을 해제하고 초안을 유지하며 설정 변경을 허용하는 Chrome 회귀를 추가했다. 재개는 `--id`와 TUI 지원을 함께 확인한다. 리뷰에서 발견한 두 보완 뒤 최종 전체 suite를 재실행했다.

## 초기 설정 대기와 CLI launcher 자식의 대화 연결 수정

2026-10-11 실제 4174 예제에서 첫 요청 후 SID·메시지·상호작용이 모두 없는 상태를 재현했다. CLI 데이터 디렉터리가 비어 있으면 SDK의 격리 디렉터리로 실행되므로, 기존 모델 인증 설정이 적용되지 않아 `Welcome to Cline` / `Connect a model provider to get started.`에서 기다렸다. SID 이전의 해당 화면을 공개 `snapshot.startup.state=provider-setup-required`로 노출하고, 초안을 보존한 채 작업 중단을 허용한다. confirmed 중단 뒤에만 첫 요청 pending을 해제한다. fixture는 실제 초기 설정 화면의 읽기 전용 capture를 40x120 화면으로 재구성했으며 인증 값은 포함하지 않는다.

사용자가 선택한 `/home/kalstein/.cline/data`를 지정한 뒤에는 CLI가 명령 승인을 기다렸지만, launcher 부모와 실제 CLI 자식의 PID가 달라 SDK가 SID를 찾지 못했다. SDK supervisor의 CLI/supervisor identity, boot ID, 추적 오류 없음 및 실제 PID/startTime 일치를 확인한 소유 자식의 manifest를 연결 대상으로 허용한다. 후보가 여러 개면 연결을 추정하지 않는다. 현재 CLI 자식은 idle 판정에서 도구 프로세스와 구분하되 전체 소유 프로세스의 중단 검증에는 계속 포함한다. 설정·history 파일에는 쓰지 않는다.

실제 자동 발견 CLI와 기존 인증 디렉터리로 `디렉토리에 파일들 뭐있어?` 요청을 한 번 제출했다. 4174 Chrome에서 `ls -la /home/kalstein/vscode` 승인 카드, 승인 전달 확인, 폴더 목록의 최종 답변과 다음 메시지 준비를 확인했다. CLI 버전 조회·버전 비교는 하지 않았다. 화면 증거는 `evidence/chat/startup-wrapper-directory-reply.png`이다. 이는 개발 WSL 환경 검증이며 회사 CLI 수용 결과를 의미하지 않는다.

모델이나 인증이 필요 없는 실제 SSH 회귀는 다음 명령으로 실행한다. 테스트 소유 임시 launcher가 실제 자식 프로세스에서 manifest/history와 TUI composer를 생성한다. 공개 connect/start/refresh/sendMessage/stop으로 SID·답변·후속 메시지 전달·전체 종료를 확인하며, 소유권 불일치 및 추가 도구 자식이 입력을 차단하는지 검증한다. SSH 대상이 없을 때 이 시험만 skip한다.

```powershell
$env:CLINE_SDK_TEST_SSH_HOST='wsl'
npm test
```

수정 후 실제 SSH 시험을 포함한 전체 `npm test`는 **143/143 통과**, 실패·skip 0(약 59초), SDK TypeScript build 및 예제 서버 `tsc --checkJs` 통과. Standards·Spec 리뷰 모두 잔여 발견 사항이 없다. 브라우저 앱에 별도로 `tsc --checkJs`를 적용하면 기존 DOM `HTMLElement`/`Element` 타입 오류가 있으며, 이를 전체 앱 타입 검사 통과로 표현하지 않는다.
