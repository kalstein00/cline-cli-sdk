# 진단 검토·가림 사본·로컬 반출 (#12)

원본 진단 묶음을 수정하지 않고 새 디렉터리에 반출 사본을 만든다. 자동 업로드·전송은 없다. [현재 SDK 시작 안내](usage.md), [수집과 원시 재생](diagnostics.md), [회사 테스트 절차](company-test.md)를 함께 사용한다.

공개 API는 `reviewDiagnostic(path)`, `inspectDiagnostic(path,{index,offset?,maxCharacters?,reviewToken?})`, `previewDiagnosticExport(path,{reviewToken,masks?})`, `exportDiagnostic(path,{destination,reviewToken,masks?,maxBytes?})`다. 검토 결과의 reviewToken은 manifest와 journal의 실제 바이트를 묶는다. 검토 후 원본이 바뀌면 준비·반출은 diagnostic-review-stale로 거부한다. UI의 내용 페이지도 같은 token을 확인한다.

검토는 포함된 관측 종류·전체 개수·경로·묶음 식별·무결성·잘림·재생 제한·제외한 소스 정책을 보여준다. 각 항목은 원시 observation, 실제 base64 바이트, UTF-8로 읽은 decodedData, 비교 sidecar의 모든 events/snapshot을 포함한다. inspect의 기본 페이지는 4,096자, 최대 16,384자다. 전체 항목과 페이지를 순서대로 열 수 있으며 큰 묶음을 DOM에 통째로 반복 출력하지 않는다. UTF-8 분할 패킷의 단독 표시에는 replacement character가 보일 수 있다. 실제 재생에는 해당 표시 문자열이 아닌 원래 바이트를 사용한다.

자격 증명 제외 표시는 수집기가 SSH 설정·키와 provider/settings 파일을 수집하지 않는 정책을 확인한 것이다. 대화·도구 인자·출력·응답에 사용자가 넣은 임의 비밀까지 자동 탐지했다고 뜻하지 않는다. manifest, 모든 원시 관측, 모든 비교 sidecar를 사람이 검토한다. 원본 수집 단계에서 제외한 system/provider/model 필드는 [진단 계약](diagnostics.md)에 기록되어 있다.

## 사본 가림과 영향

사용자가 선택한 literal 문자열만 가린다. 한 번에 최대 64개, 각각 1–1,024자다. 정규식이나 추측한 토큰 탐지에 의존하지 않는다. history의 텍스트·도구 인자/결과와 실제 PTY·응답 입력·터미널 증거를 가린다. PTY와 같은 요청의 입력 바이트는 분할 경계를 가로질러 일치하는 UTF-8 문자열도 가린 뒤 원래 패킷 길이로 다시 나눈다. 선택에 포함되지 않은 ANSI 바이트와 순서·seq·시각·분할 경계·식별자를 보존한다. history/JSON 내용의 바이트 길이는 달라질 수 있다.

식별자·PID/start time/boot ID·시각·hash·CLI 프로필·프로토콜 구조와 겹치는 선택은 diagnostic-mask-identity 또는 diagnostic-mask-key로 거부한다. 이런 값을 임의로 바꾸고 동일 작업의 근거라고 표시하지 않는다. 가림 계획은 일치한 횟수와 선택 문자열의 SHA-256만 남긴다. 원문 선택값을 변환 이력에 저장하지 않는다.

가린 사본에서는 원래 예상 events/snapshot을 전부 제거한다. 그 sidecar를 통해 가린 내용이 다시 노출되거나 원본과 동일하다고 판정하지 않는다. `compareDiagnostic`은 available false, matches false와 이유를 반환한다. 원시 가림은 메시지·질문·선택지·전달 근거의 해석을 바꿀 수 있으며, semanticEquivalence는 not-assumed다. 다시 반출한 사본도 이 제한을 계승한다. 원문 사본은 raw/sidecar를 유지하고 실제 재생 결과와 대조할 수 있다.

원본과 사본은 서로 다른 bundleId를 가진다. 사본의 export metadata에는 원본 bundleId·manifest/journal SHA-256, 반출 시각, 변환 이력, 보존 항목, 해석 영향이 남는다. 각 원시 관측 hash에 더해 사본의 raw+comparison 줄 hash와 전체 journal hash를 검증한다. 이 hash는 우발적 변경/손상을 검출하는 것이며 송신자 신원 인증을 대신하지 않는다.

## 제한과 실패

기본 반출 한도는 16 MiB이며 4 KiB–256 MiB로 설정할 수 있다. manifest는 64 KiB, 읽는 journal은 최대 256 MiB다. 새 destination의 상위 디렉터리는 이미 있어야 한다. 원본 안의 경로, 기존 파일/디렉터리/심볼릭 링크에는 쓰지 않는다. 파일은 새 사본 디렉터리 안에서 exclusive create로 저장한다. 실패 시 원본은 그대로 남으며 부분 생성된 사본을 성공으로 반환하지 않는다.

새 원본과 사본의 raw/sidecar·순서·줄 수·전체 journal 손상은 같은 검증기로 corrupt/blocked를 표시하고 재생·검증된 반출을 거부한다. truncated 플래그만으로 hash 불일치를 허용하지 않는다. 실제 마지막 줄이 찢어졌으며 앞 줄의 chain과 종료 count/bytes가 확인되는 경우에만 truncated/partial로 앞 관측을 해석한다. 완전한 행 삭제는 잘림으로 허용하지 않는다. 부분 비교는 matches false, 앞 구간이 일치하면 prefixMatches true다. 부분 사본은 불완전 tail을 버린 사실과 잘림을 유지한다.

이전 raw-only 원본은 limited/partial로 열고 전체 sidecar 비교는 available false다. 새 사본도 원본의 limited 한계를 계승하며 원본에 신뢰 hash를 소급해서 쓰지 않는다. 아래 초기 Windows 실제 반출 결과는 당시 판정의 역사적 근거이며 새 chain/finalize 보증을 적용한 기록이라는 뜻이 아니다. 미지원 CLI 프로필·상호작용은 재생 중에도 조작을 허용하지 않는다. 재생은 SSH·모델·원격 입력을 실행하지 않는다.

## 실행 명령과 화면

```powershell
npm ci
npm run build
node examples/node/export.mjs review <원본-기록-디렉터리>
node examples/node/export.mjs content <원본-기록-디렉터리> 0 0
# nextOffset 또는 다음 index로 모든 포함 내용을 검토한다.
node examples/node/export.mjs export <원본-기록-디렉터리> <새-로컬-사본-디렉터리> '직접 선택한 민감 문자열'
node examples/node/export.mjs replay <사본-디렉터리>
npm run example:web
```

웹에서는 수집을 종료한 뒤 기록 경로 → `포함 항목 검토` → 관측 번호/내용 페이지 → `가릴 원문` → `가림 계획 확인` → 새 경로 → `검토한 사본 내보내기`를 사용한다. 빈 가림 목록은 원문 사본이다. 성공 후 열 기록 경로가 사본을 가리키며 `기록 열기·오프라인 비교`로 제한과 결과를 확인한다.

## 검증 근거

공개 API 시험은 모든 raw/sidecar 내용의 유한 페이지, split UTF-8 PTY 실제 바이트 가림, 원본 파일의 byte-identical 보존, ID/seq/시각 유지, normal replay 일치, masked 비교 불가, sidecar 손상 검출, truncated prefix, stale review, 원본/기존 경로/junction overwrite 차단, 반출 용량 한도와 실제 바이트 합계를 검사한다. 진단 종료 뒤 반복 종료·닫기가 manifest의 시각을 다시 쓰던 문제는 공개 red→green 시험으로 수정했다. 동시 종료도 한 번만 finalize하며 반출 뒤 원본 바이트가 그대로 남는다. 전체 공개 API 시험은 63/63 통과했다.

2026-10-09 Windows Chrome의 실제 수집→검토→반출→오프라인 열기를 검증했다. 진단을 연결 전에 시작하고 Windows→SSH→WSL에서 이미 종료된 소유 실행을 read-only attach했다. 모델·새 작업·응답·중단·재개를 실행하지 않았다. session `1791548132816_6xzwp`, execution `run-96a7a94c-fc0d-46e7-be22-79594895b8a9`의 392관측을 수집한 뒤 종료했다.

- 원문 사본: 392관측, 428,040바이트, eventDifferences 0, snapshotMatches true. 실제 반출→기존 live client 닫기→재생 이후 원본 manifest/journal hash 모두 동일했다.
- `SDK_DIAGNOSTIC:BLUE`를 직접 선택한 사본: 392관측, 200,453바이트. history 항목 388의 실제 decodedData가 `*******************`로 바뀌었고 base64도 새 바이트다. 원래 sidecar는 없으며 available false·matches false·not-assumed를 표시했다. [원시 가림 화면](evidence/ticket-12-masked.jpg), [비교 제한 화면](evidence/ticket-12-comparison.jpg).
- sidecar revision을 바꾼 별도 **파일 장애 주입**은 corrupt/blocked와 diagnostic-hash-mismatch, 비활성 반출로 확인했다. 마지막 20자를 제거한 별도 **잘림 주입**은 391개의 완전한 앞 관측만 partial/truncated로 열었다. 해당 앞 관측 비교는 일치했지만 전체 기록이 동일하다는 뜻으로 표시하지 않는다. 실제 회사/CLI 장애로 세지 않는다.

이 브라우저 사본 크기는 당시 반출 실측이다. 이후 사본의 status.bytes에도 실제 합계를 기록하고 원래 수집 status를 source.capturedStatus로 구분했다. 마지막 경계 검증에서 원본 아래 `..copy`처럼 점으로 시작하는 디렉터리도 차단했다. 독립 npm packed 설치에서 최신 코드로 같은 실제 원본을 열고 원문/가림 사본을 만들어 재생했다. 원본/원문 사본은 차이 0, 가림 사본은 동등성을 주장하지 않았고 모든 392항목의 300,966자를 검토해 선택 원문이 없음을 확인했다. 원본 두 파일의 hash도 그대로였다. 회사 호환성은 미검증이다.
