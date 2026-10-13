# 전체 테스트 실행과 완료 이벤트

현재 live 구현은 [SSH 직접 실행](direct-ssh.md)으로 전환되었다. 아래 2026-10-11 수치와 supervisor/PTY 시험 목록은 과거 실행 기록이다. 현재 스위트는 직접 SSH 계약, 조회 전용 브라우저, 기존 기록 재생과 내보내기를 검증하며 완료 이벤트 실행 절차는 유지한다.

2026-10-11 `grill-with-docs` 설계 인터뷰 기록이다. 사용자가 범위와 구현·실제 검증을 승인했다.

## 확정한 범위

- Codex가 테스트 프로세스 출력을 반복 조회하는 실행 감시 폴링을 없앤다. SDK·예제 앱의 상태 갱신과 테스트 내부의 조건 대기는 유지한다.
- 하나의 스크립트에서 기존 `npm test` 전체를 한 번 실행한다. SDK build, 공개 API 회귀, 실제 브라우저 시험을 포함한다.
- `CLINE_SDK_TEST_SSH_HOST=wsl`로 실제 SSH·PTY 시험을 포함한다. 이 자동 시험은 시험 소유 launcher/native child를 사용하며, 설치된 회사 Cline의 호환성을 증명하지 않는다.
- 실행이 종료되면 `codex queue`로 실행을 요청한 같은 Codex 대화에 완료 이벤트를 보낸다.

## 합의한 구현

1. `scripts/run-tests-and-notify.ps1`를 숨겨진 백그라운드 프로세스로 한 번 시작한다. 실행 감시용 `write_stdin`, 반복 로그 조회, 프로세스 상태 조회를 사용하지 않는다.
2. 실행별 고유 디렉터리에 전체 출력과 구조화된 결과를 남긴다. 결과에는 실행 ID, 시작·종료 시각, 테스트 종료 코드와 로그 경로를 포함한다.
3. 성공·실패 모두 종료 시 같은 대화 ID로 완료 이벤트를 한 번 전달한다. 프로젝트 지침의 `codex-internal.ps1`을 통해 `queue --thread <ID> --message <TEXT>`를 실행한다. 다른 대화나 최신 대화를 추측하여 선택하지 않는다.
4. 테스트 결과를 먼저 저장하고 큐 전달 결과를 별도로 남긴다. 큐 전달이 실패해도 테스트를 자동 재실행하지 않는다. 큐 명령 성공은 큐 요청의 성공이며 사용자 열람의 증거로 표현하지 않는다.
5. 완료 이벤트에는 실행 ID, 성공·실패, 종료 코드, 결과·로그 경로를 넣는다. 이벤트를 받은 Codex는 결과를 읽어 보고하며 테스트를 자동 재실행하지 않는다.
6. 사용자 예제 서버나 기존 원격 Cline 대화를 재시작하거나 중단하지 않는다. 테스트가 만든 자원의 정리는 기존 테스트의 책임을 유지한다.

## 확인 근거

- `package.json`: `npm test`는 `npm run build && node --test tests/*.test.mjs`다.
- `tests/chat-browser.test.mjs`: Playwright로 실제 브라우저 화면을 검증한다.
- `tests/wrapper-session.test.mjs`: SSH 환경 변수가 있어야 실제 SSH 시험을 실행한다. 없으면 skip한다.
- 설치된 CLI의 `queue --help`: `codex queue --thread <THREAD> --message <TEXT>`를 지원한다. 아래 실행에서 큐 전송과 같은 대화의 완료 이벤트 수신을 확인했다.
- [공식 CLI 명령 참조](https://learn.chatgpt.com/docs/cli/reference)에는 현재 `codex queue` 항목이 없어, 이 명령의 지원 여부는 설치된 CLI 도움말을 근거로 삼았다.

일반 테스트 실행 절차이므로 원격 Cline 도메인의 용어집 항목이나 ADR을 추가하지 않는다.

## 실행

저장소 루트에서 요청한 대화 ID를 지정해 실행한다. Codex shell에서는 현재 `CODEX_THREAD_ID`를 기본으로 사용한다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run-tests-and-notify.ps1 -Background -ThreadId $env:CODEX_THREAD_ID -SshHost wsl
```

명령은 실행 디렉터리·PID·대화 ID를 출력하고 즉시 반환한다. 이후 출력이나 프로세스 상태를 반복 조회하지 않고 완료 이벤트를 기다린다. `.test-runs/<실행 ID>/`에 `started.json`, `test.log`, `result.json`, `queue.log`, `notification.json`을 남긴다. 실행 디렉터리는 재사용하지 않는다.

`result.json`은 테스트 결과이며 `notification.json`은 큐 요청 결과다. 큐 요청이 실패한 경우 이미 저장된 결과를 확인하고 필요할 때 같은 결과의 이벤트만 수동 전달한다. 테스트를 자동 재실행하지 않는다. 큐 실패는 이 대화에 이벤트를 보내지 못할 수 있으므로 실행 기록은 독립적으로 보존한다.

## 실제 검증 결과

- 실행 ID: `20261011T131702628Z-c37698c3421c422081e2743b4f42708d`.
- 2026-10-11 22:17:03~22:18:42 KST에 `CLINE_SDK_TEST_SSH_HOST=wsl`로 전체 테스트를 한 번 실행했다. 전체 소요 약 99초, Node 시험 소요 약 95초다.
- **155/155 통과**, 실패·취소·skip 0, 테스트 종료 코드 0. 실제 브라우저 시험과 시험 소유 launcher/native child의 실제 SSH·PTY 시험을 포함했다.
- 큐 명령 종료 코드 0, 메시지 ID `01a12b1d-9ebb-7970-a9ea-9dcd874f8a72`. 요청한 같은 대화 `01a129f9-cb14-7e62-af35-2a18de56286b`에서 완료 이벤트를 받았다.
- 실행 감시 폴링 없이 이벤트를 받은 뒤 저장된 결과·로그·큐 요청 기록을 읽었다. 테스트를 재실행하지 않았다.
- PowerShell 구문 검사, 잘못된 대화 ID 및 이미 존재하는 실행 디렉터리의 실행 전 거부도 확인했다. 테스트 실패·큐 전송 실패의 실제 장애 주입은 수행하지 않았으며, 성공 경로의 완료 이벤트 검증과 구분한다.

원본 결과는 `.test-runs/<실행 ID>/`에 보존한다. Git에는 실행 로그를 추가하지 않는다.
