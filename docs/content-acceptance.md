# #14–19 수용 근거

2026-10-10, Windows Node 24.16.0 → WSL Linux의 고정 공개 Cline CLI 3.0.69로 확인했다. CLI SHA-256은 `8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032`다. 회사 CLI의 실제 버전·출력·접속 자료는 없으므로 #13은 미검증으로 유지한다.

| 경계 | 결과 | 근거와 한계 |
| --- | --- | --- |
| 공개 SDK 계약 | 통과 | `npm test`: 85/85. start/snapshot/subscribe 및 공개 replay에서 기능별 RED→GREEN 검증. 외부 OpenSSH 경계의 주입 시험은 실제 회사 실행을 뜻하지 않는다. |
| 실제 JSON 관측 | 통과 | `--json` 실행, stdout 레코드/history 대조, 최종 JSON 파싱·SDK Schema 검증, exit 0·manifest completed·supervisor/자식 종료 확인. `--zen`을 실행 인자로 사용하지 않는다. |
| 별도 Node 소비 프로젝트 | 통과 | `npm pack` 산출물을 저장소 밖 새 npm 프로젝트에 설치했다. 두 개의 서로 다른 SID/run에서 시작→답변→client.close→새 client 연결/list/attach→SDK Schema 결과→확인된 stop→진단 반출→raw replay의 이벤트/snapshot 일치를 검사했다. |
| 같은 대화 재개 | 통과 | 첫 SID를 유지한 새 run에서 `RESUME_NEW_RUN` 답변을 받았다. 이전 result를 비우고 종료된 이전 run과 새 run을 구분했다. 새 실행의 stop/childrenVerified도 확인했다. JSON 모드 재개는 공개 API에서 `unsupported-json-resume`로 거부한다. |
| 노출된 think | 합성 시험 통과 | mixed/think-only/think-only 갱신/가려진 marker/부분 history 및 진단 왕복을 검증했다. 실제 두 세션에서는 thinking 부분이 0개였다. 모델의 실제 think 출력 수신 성공을 주장하지 않는다. |
| JSON/Schema 오류 | 통과 | 부분 출력 pending, invalid-json, schema-mismatch, interrupted, unconfirmed를 구분한다. 객체/배열/원시값·한글, nested/type/required/enum/additionalProperties/local ref 및 실행 전 Schema 거부를 공개 API로 검사했다. |
| 브라우저 | 통과 | 합성 think/가려진 marker, 펼침 유지, 세션 전환, JSON 문법 오류, Schema 위치 오류를 실제 Chrome에서 조작했다. 실제 JSON 모드 요청의 ready/value와 CLI 종료도 확인했다. 실제 수집 묶음의 검토→새 사본 반출→공개 재생 비교를 수행했다. |
| 진단 반출 | 통과 | adapterVersion 2. 요청 계약과 raw 관측에서 Schema 결과를 다시 계산한다. JSON 패킷 경계에 걸친 마스크도 처리한다. 가림 사본 비교는 unavailable이며 원본을 변경하지 않는다. legacy adapter는 raw 읽기를 유지하되 현재 해석과 정확 비교 불가를 명시한다. |
| 네이티브 Schema 생성 강제 | 미지원 경계 확인 | `validation:"native"`는 실행 전 거부한다. SDK 결과 검증을 네이티브 constrained generation으로 보고하지 않는다. |
| 회사 프로필 | 미검증 | 사용자 선언 `zen:false/jsonOutput:true`와 help/실행 파일 검증을 분리한다. 선언이나 `--json` 존재만으로 질문 응답·재개·네이티브 Schema 조작을 허용하지 않는다. |

실제 SID/run/요청·중단 근거는 [actual-sessions.json](evidence/content/actual-sessions.json)에 저장했다. 원시 진단은 인증자료를 제외하는 SDK collector로 로컬 Temp에만 저장했다. 공개 근거에는 제어된 시험 답변만 포함했다. 인증 설정 사본은 격리 시험 데이터 디렉터리에만 사용하고 수용 종료 후 제거한다.

화면: [실제 JSON](evidence/content/actual-json.png), [think 합성](evidence/content/think-json.png), [Schema 불일치](evidence/content/schema-mismatch.png), [JSON 문법 실패](evidence/content/json-invalid.png), [native 실행 전 거부](evidence/content/native-rejected.png), [진단 반출·재생](evidence/content/diagnostic-export.png).

재현용 소비 예제는 [structured.mjs](../examples/node/structured.mjs)다. 패키지를 별도 프로젝트에 설치한 뒤 `CLINE_SDK_HOST`, `CLINE_SDK_CLI_PATH`, `CLINE_SDK_REMOTE_ROOT`, `CLINE_SDK_WORKSPACE`, `CLINE_SDK_DATA_DIR`, `CLINE_SDK_EVIDENCE_DIR`를 준비해 실행한다. 인증은 CLI의 격리 dataDir에 별도로 준비한다. 두 세션의 대화/구독/결과 식별자와 중단 근거를 assert하며 자동 복구 요청이나 재시도를 하지 않는다.

## 회사 #13 테스트 체크리스트

1. 비밀을 제외한 버전·실행 파일 해시·`--help`, OS/Python/PTY/tmux, CLI dataDir/session/history 위치를 수집한다. 회사 옵션 선언과 실제 help 근거를 각각 남긴다.
2. 진단을 연결 전에 시작한다. 평상시에는 로컬 원시 기록을 영구 저장하지 않는다. 알 수 없는 실행 파일이 ready:false/조작 차단을 유지하는지 확인한 후 회사 관측에 맞는 검증 프로필을 별도로 만든다.
3. `--zen` 없이 두 개 이상의 새 세션에서 시작→대화→client.close→새 client/list/attach→중단을 반복한다. sessionId/executionId/requestId/messageId와 구독·현재 답변이 섞이지 않는지 확인한다.
4. `--json` stdout/stderr, 패킷 분할, 질문/도구/최종 결과, process/manifest/자식 종료를 기록한다. 미확인 JSON 입력·재개는 거부를 유지하고 성공으로 세지 않는다.
5. think 노출 시 ordered content와 think-only 갱신을 확인한다. redacted marker는 불투명 원문을 반환하지 않아야 한다. 노출이 없으면 미관측으로 기록한다.
6. 일반 JSON·잘못된 JSON·부분/중단 출력과 Schema 적합/불일치를 검사한다. 네이티브 요청은 실제 검증된 경로가 없으면 실행 전 거부해야 한다.
7. 모든 포함 항목을 검토하고 필요한 think/Schema/응답 원문을 가린 새 사본만 반출한다. 인증 설정·키 파일은 포함하지 않는다. 원본과 사본의 변환·재생 제한을 기록한다.
8. 개발 PC에서 공개 SDK로 raw 재생하고 이벤트/snapshot을 비교한다. 잘림·누락·손상·구버전 제한을 포함해 #13에 근거를 남긴다. 공개 CLI와 합성 성공을 회사 수용으로 대체하지 않는다.
