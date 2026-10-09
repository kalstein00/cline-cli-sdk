# think와 구조화 결과

회사 CLI는 사용자 확인으로 `--zen` 미지원, `--json` 지원이다. 정확한 버전·실행 파일·출력 자료는 아직 없어 회사 프로필은 미검증이다. `ConnectionOptions.declaredFeatures`로 이 정보를 전달해도 실행 파일 식별이나 입력 경로 검증을 생략하지 않는다.

`preflight().features`와 `capabilities().features`는 기능별 지원 상태와 근거(`verified-profile`, `help`, `declared`, `unobserved`)를 반환한다. CLI의 `--json` 옵션, JSON 모드의 질문 응답·재개, 메시지 thinking, 모델의 네이티브 JSON Schema 생성 강제는 별도 기능이다. `outputModes`는 SDK에서 실제 선택 가능한 출력 모드다. 예제의 기능 패널과 모드 선택은 같은 공개 계약을 사용한다.

현재 관리 실행은 `--zen`을 사용하지 않는다. 연결 해제·닫기는 원격 작업 중단이 아니며 실행 유지에는 기존 Python·PTY·tmux 및 프로세스 소유 확인 조건을 사용한다. 알 수 없는 회사 실행 파일은 관측된 옵션만 보고하고 조작을 허용하지 않는다. 회사 실측은 #13에서 관리한다.

`Message.content`는 노출된 `thinking`·`text`·`redacted_thinking` 부분의 순서를 보존한다. 기존 `Message.text`에는 일반 본문만 들어간다. think만 변경되어도 같은 메시지의 `message.upsert`를 받으며, think만 있는 메시지도 조회할 수 있다. `redacted_thinking`에는 가려진 데이터를 반환하지 않는다. thinking 부분이 없다는 것은 현재 관측에서 think가 없다는 뜻이며 모델의 내부 추론 유무를 보증하지 않는다. 예제는 think를 접기 영역으로 표시하고 갱신 시 펼침 상태를 보존한다.

JSON 관측은 start({outputMode:"json"})으로 선택한다. 고정 프로필은 TUI와의 조합 및 JSON 모드 재개·응답을 실행 전에 거부한다. stdout의 newline JSON 레코드와 stderr를 별도로 수집하고 snapshot.jsonOutput에 최종 run_result와 현재 레코드 상태를 제공한다. 메시지는 읽기 전용 history로 대조하므로 스트림과 파일이 같은 답변을 중복 생성하지 않는다. JSON 레코드의 성공과 원격 프로세스·자식·manifest 종료 확인은 별도이며, 알 수 없는 레코드·부분 레코드·누락을 성공으로 취급하지 않는다.
JSON 결과는 resultFormat:{type:"json",requestId:"consumer-request-1"}으로 요청한다. snapshot.result와 result.changed는 원문·파싱 값·현재 요청 식별자·상태를 제공한다. 답변 완료 근거가 없는 부분 출력은 pending이며, JSON 문법 실패는 invalid-json, 중단/실패는 interrupted, 누락/기록 실패는 unconfirmed다. 코드 펜스 제거·타입 강제 변환·자동 재요청을 하지 않는다. JSON.parse의 Number 정밀도 한계가 적용되며 큰 정수는 스키마에서 문자열로 표현해야 한다. JSON 출력 run_result, 확인된 프로세스 완료 또는 검증 프로필의 TUI idle manifest와 composer를 최종 답변 근거로 사용한다. 도구 호출 본문·도구 결과·지난 요청의 baseline 메시지는 결과 후보에서 제외한다.

resultFormat에 schema와 validation:"sdk"를 지정하면 SDK가 JSON Schema를 프롬프트에 전달하고 최종 답변을 검증한다. 스키마 통과 결과만 ready/value를 제공하며 실패는 schema-mismatch/errors로 반환한다. validation:"native"는 검증된 네이티브 생성 경로가 없어 원격 실행 전에 unsupported-native-schema로 거부한다. 자동 수정/재요청이나 SDK 검증 모드로의 자동 전환은 없다.

Schema는 draft 2020-12의 엄격 검증을 사용한다([Ajv JSON Schema](https://ajv.js.org/json-schema.html), [strict mode](https://ajv.js.org/strict-mode.html)). 제한은 64 KiB·2048 JSON 값·깊이 32다. 객체/배열/type/required/enum/const/additionalProperties 및 중첩·합성 규칙과 해석 가능한 비재귀 로컬 JSON pointer 참조를 지원한다. 원격/미해결/재귀 참조, 다른 draft, $id/$async/$dynamicRef/$recursiveRef, 정규식 pattern/patternProperties 및 미등록 format·알 수 없는 키워드는 실행 전에 거부한다. 기본값 주입·타입 강제 변환·추가 속성 삭제를 하지 않는다. structuredResults capability는 SDK의 JSON/Schema 검증 지원과 nativeSchema:false를 별도로 표시한다. 스키마 요청 계약은 관리 실행의 제한된 원격 제어 메타데이터에 보존하여 재연결 때 재사용하며 대화 원문/결과는 CLI 기록에서 읽는다.

이미 확정된 답변의 결과는 같은 run을 중단해도 보존한다. 현재성이 깨지면 unconfirmed로 바뀌며 새 실행/같은 세션 재개는 이전 result를 초기화한다. 현재 resume는 새로운 resultFormat을 받지 않으므로 JSON/Schema 계약이 필요한 새 작업은 start로 요청한다.

관리 실행의 결과 계약에는 실제 전달 프롬프트의 SHA-256 binding을 저장한다. 같은 SID의 새 실행이 history를 갱신한 뒤 이전 run에 attach하면 다른 요청의 답변을 반환하지 않고 unconfirmed로 표시한다. 같은 프롬프트의 여러 user turn도 모호한 요청으로 거부하고, 재개된 실행은 supersededBy binding으로 이전 run의 결과 귀속을 차단한다. 변경된 본문은 새 process 관측 또는 일치하는 JSON run_result까지 pending이며, 출력 오류·누락은 기존 성공 값을 무효화한다.

Schema 참조를 펼친 순회는 8192개 노드로 제한한다. 마스크는 JSON 전송과 JSON 답변의 escaping을 해석해 적용하고 바이트 길이를 유지한다. JSON이 잘리거나 손상돼 해석할 수 없거나 변경이 길이를 늘리면 가림 반출을 명시적으로 거부한다. 가림 사본의 원래 결과와 비교는 unavailable이다.

수용 범위·실제 두 세션·진단 왕복·회사 체크리스트는 [content-acceptance.md](content-acceptance.md)에 기록했다.
