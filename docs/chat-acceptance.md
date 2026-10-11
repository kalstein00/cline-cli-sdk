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
