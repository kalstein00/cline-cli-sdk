# 회사 Windows → SSH → Linux 테스트 및 진단 반출 절차

현재 회사 CLI 버전·접속 조건·실측 자료는 제공되지 않았으므로 회사 프로필은 미검증이다. 공개 Cline의 성공이나 회사 자료의 offline replay를 회사 환경의 재시험으로 세지 않는다. 이 절차는 #13에서 실제 결과를 받을 때 사용한다.

## 준비와 지원 판정

1. 회사 테스트 담당자가 승인된 SSH alias/agent/key와 경유 조건을 준비한다. 암호·개인 키·provider/settings 원문을 앱·명령 로그·진단·이슈에 붙이지 않는다. SDK는 BatchMode와 StrictHostKeyChecking을 사용한다. 이 조건으로 접근할 수 없으면 인증/경유 장애를 결과에 기록한다.
2. Linux·Python 3.9 이상·PTY·tmux와 실행 유지 조건을 [환경 안내](live.md)로 확인한다. SDK가 prerequisite을 자동 설치하거나 전역 CLI/설정을 바꾸지 않는다. WSL에서는 SSH 클라이언트 상실과 WSL 자체 종료를 구분한다.
3. CLI의 정확한 경로·version·SHA-256을 기록하고 테스트 동안 파일이 바뀌지 않았는지 확인한다. 작업은 별도의 디렉터리, CLI dataDir, SDK 관리 remoteRoot에서 수행한다. 인증 사본이 필요한 경우 승인된 원격 내부 절차로만 소유자 전용 사본을 준비한다. 내용을 출력하지 않는다.
4. 회사 Windows에서 패키지/예제를 실행하고 진단 수집을 연결 전에 선택한다. 저장 위치와 유한 한도를 확인한 뒤 연결·환경 점검을 수행한다. 환경 보고의 ready, profile.supported, companyCompatibility, problems를 기록한다.
5. 현재 지원 fingerprint와 다르면 unknown profile이다. 시작·응답·승인·재개를 우회하거나 임의 키 입력으로 진행하지 않는다. 이 단계에서는 연결/실패 기록과 화면의 버전/hash/prerequisite 보고를 검토해 로컬로 보존할 수 있으나, SDK가 미지원 회사 CLI의 질문을 실제 수집/조작했다고 주장하지 않는다. 알려지지 않은 프로필의 화면·세션 구조를 확보할 추가 관찰 절차는 #13에서 담당자와 합의한다. 회사 CLI 자체를 수정하지 않는다.

## 검증 가능한 프로필의 시나리오

각 시나리오에 sessionId/executionId/interactionId/requestId, 시각, 실제 CLI 버전/hash, 사용한 모드와 진단 bundleId를 연결한다. 지원 범위가 확인된 동작만 수행한다.

| 시나리오 | 확인할 결과 |
| --- | --- |
| 선택·자유 응답 | 현재 질문 하나, 같은 단계에 전달, 문자열·숫자 선행·한글/멀티바이트 보존, 동일 작업 계속 진행. |
| 승인/거절·후속 질문 | 전체 도구 인자 표시, 승인 실행/거절 미실행, retry-limit 후속 질문의 별도 identity. |
| 단절·GUI 재시작 | Linux는 유지하고 같은 실행/대기 질문 복구. 원격 머신 종료·boot 변화는 별도 장애 시나리오. |
| 제출 직후 단절 | delivery-unknown, 자동 재전송 없음, 원래 requestId의 CLI 수신 근거로 명시적 재확인. |
| 중단·재개 | CLI와 추적한 자식 종료 proof, 대화 보존, 같은 session/새 execution의 후속 입력·저장 메시지. |
| 기록 동기화 | 부분 JSON/읽기 실패/교체 동안 마지막 유효 내용을 보존하고 완전한 재관측으로 복구. 실제 장애와 주입 시험을 구분. |
| 미지원 화면·종료 근거 누락 | unsupported/unknown과 차단된 조작. 완료로 추정하지 않음. |

원격 실행을 종료할 때는 공개 stop 결과의 confirmed/unknown, childrenVerified, remaining을 확인한다. 진단 수집 종료·연결 해제·GUI 종료는 작업 중단을 대신하지 않는다. 인증 사본·임시 keepalive는 테스트 소유 대상을 확인한 뒤 정리하며 전역 설정과 원본 대화를 삭제하지 않는다.

## 검토·반출·개발 PC 분석

1. 진단 종료 후 경로·bytes·observations·truncated·failure를 확인한다. 누락한 앞/뒤 관측이나 저장 한도 초과는 결과에 남긴다.
2. [반출 안내](export.md)에 따라 manifest와 모든 raw/sidecar 항목·페이지를 검토한다. 대화·명령 출력·도구 인자·사용자 답변의 민감 값을 직접 선택하고 가림 계획의 일치 수/제한을 확인한다.
3. 원본을 보존하고 존재하지 않는 새 로컬 경로에 사본을 내보낸다. 원본·사본 ID/hash·변환·재생 영향·잘림 여부를 확인한다. 가린 사본의 동등성은 가정하지 않는다. 자동 외부 업로드는 없다.
4. 사용자가 회사 반출 정책에 맞는 전달 경로로 검토한 사본과 별도의 버전/hash/환경·시나리오 보고만 개발 담당자에게 전달한다. 이 예제는 외부 전송을 수행하지 않는다.
5. 개발 PC에서 SDK 공개 read/review/openReplay/replayAll을 실행한다. SSH 설정 없이 raw 관측을 같은 decoder에 공급한다. normal/masked/corrupt/truncated와 비교 가능 범위를 먼저 확인한다. 예상 normalized sidecar를 초기 상태로 주입하지 않는다.
6. 원시 근거에서 최소한의 검토 fixture를 만들어 공개 API 회귀 시험을 추가한다. 수정의 offline 재현 결과를 기록하고, 동일 회사 CLI에서 담당자가 실제 재시험한 결과를 별도로 받아 해당 프로필 지원 범위를 판정한다.

## 결과 보고 구분

보고에는 환경/prerequisite 장애, 지원 불가 프로필/상호작용, 정상 동작, 전달 불명/종료 확인 실패, 손상/부분 기록을 구분한다. 공개 CLI 실제 실행, 자동 fixture/주입 시험, 실제 Windows 브라우저, 회사 실제 실행·재시험을 각각 표시한다. 회사 실행 근거가 없으면 companyCompatibility는 unverified로 유지하며 #13을 완료로 처리하지 않는다.
