# WSL Cline 3.0.69 실제 연동 관찰

2026-10-09 Windows 개발 PC에서 `ssh wsl`로 접속해 실제 모델을 실행했다. **WSL 공개 CLI의 질문·응답, 승인·거절, SSH 클라이언트 상실 후 응답, 중단과 같은 세션 재개를 확인했다. 회사 fork와 SDK 구현의 검증 결과는 아니다.**

## 관찰 조건과 증거

- 대상: WSL Ubuntu-24.04, tmux 3.4, Cline 3.0.69. 실제 실행 manifest의 provider/model은 `openai-codex` / `gpt-6-luna`였다.
- 고정 실행 파일 SHA-256: `8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032`.
- 원격 관찰 루트: `/home/kalstein/cline-sdk-observe-20261009-9qzzex7j`. 작업 디렉터리, CLI 데이터, recorder와 고정 CLI를 여기에 분리했다.
- Windows 원문 기록: 저장소의 `.observations/20261009/`. 이 경로는 Git에서 제외했다. `summary.json`은 실행별 원문 기록 해시와 이벤트 수를 담는다.
- `scripts/observations/remote_probe.py`가 PTY 출력·입력 바이트를 base64로, 순서와 단조 시각을 함께 기록했다. 격리된 세션 파일만 주기적으로 읽어 바이트·해시·JSON 파싱 성공 여부를 기록했다. 파일 감시를 완성한 SDK는 아니다.
- 기존 인증 설정을 내용 출력 없이 소유자 전용 권한의 테스트용 사본으로 사용했다. 해당 사본은 관찰 후 제거했고, 인증 설정은 진단 기록이나 Windows 반출 대상에 포함하지 않았다.
- CLI 자동 업데이트 억제 방법을 확인한 뒤 `choice-live`부터 `CLINE_NO_AUTO_UPDATE=1`을 프로세스 시작 전에 적용했다. 설치 소스 근거는 [별도 조사](cline-3.0.69-source-findings.md)에 있다.
- 원문 기록 11개와 세션 파일 snapshot 166개의 해시·순서·허용 파일 경로를 검증했다. 이것은 기록 무결성 검사이며 SDK의 기록 재생 또는 회사 CLI 수용 검증이 아니다.
- Windows 진단 묶음: `.observations/20261009-diagnostics.zip`, SHA-256 `25f28e207f6da7f04c2acac7f8b1806161336dbe58fe06881b7f2e3661bf82b4`. 원문을 포함한 로컬 조사 자료이며, 회사 자료의 가림 처리·반출 도구를 구현한 결과는 아니다.

## 실제 결과

아래 실행 이름은 `.observations/20261009/logs/<실행 이름>/frames.ndjson`에 대응한다.

| 관찰 | 실행 / 근거 | 실제 결과와 한계 |
|---|---|---|
| 일반 응답 | `baseline` | `OBSERVATION_READY` 응답과 종료 코드 0. 초기 `--retries 0`은 유효하지 않아 무시됐으며 이후 시험은 1로 지정했다. |
| 선택형 질문 | `choice-live` | `ask_question` 도구 승인 후 RED/BLUE 질문을 받았고 `2` 입력이 `CHOSEN:BLUE`로 이어졌다. |
| 자유 입력 | `free-live` | 선택형 질문에 `CUSTOM-42`를 직접 입력했고 `LABEL:CUSTOM-42`로 완료했다. |
| SSH 클라이언트 상실 후 응답 | `free-live/reconnect.json`, Windows `ssh-client-tree-drop.json` | 질문 대기 중 Windows SSH 클라이언트와 그 하위 연결 프로세스를 종료했다. 새 SSH에서 tmux client가 없고 동일 CLI PID 3428이 살아 있음을 확인한 뒤 응답하여 같은 실행을 완료했다. 물리 네트워크 장애·서버 재부팅까지 검증한 것은 아니다. |
| 명령 승인 | `approve-live` | `run_commands`의 `printf APPROVAL_PROBE`를 `y`로 승인했고 실제 출력과 `APPROVED:APPROVAL_PROBE`를 확인했다. |
| 명령 거절 | `deny-live` | `n` 이후 tool result에 사용자 거절과 미실행이 기록됐다. `--retries 1` 환경에서는 추가 `mistake_limit_reached` 질문이 발생했다. 시험 driver의 65초 대기가 먼저 만료됐으며, 관찰자가 `2: Stop this run`으로 응답한 후 CLI가 종료 코드 0으로 종료했다. 단일 거절 응답만으로 항상 프로세스가 끝난다고 가정할 수 없다. |
| 숫자로 시작하는 일반 자유 입력 | `numeric-live` | `2 custom identifier`가 그대로 전달되지 않고 두 번째 선택지로 해석되어 `IDENTIFIER:BLUE`가 됐다. 일반 readline 경로의 임의 문자열 입력 지원은 성립하지 않는다. |
| 실행 중 중단 | `cancel-live/result.json` | 승인한 90초 대기용 Python 명령 실행 중 Ctrl+C를 보냈다. CLI 종료 코드 0, 세션 manifest `cancelled`, 자식 PID 6627 미생존, 기록 보존을 확인했다. 종료 코드 0만으로 작업 성공을 판단하면 안 된다. |
| 중단한 세션 재개 | `resume-live/resume-evidence.json` | `--id 1791537943905_i483a`로 TUI를 열어 중단 기록을 복원했다. 같은 세션에 새 요청을 보내 `RESUMED_CONFIRMED`를 저장했다. 텍스트와 Enter를 한 번에 보낸 첫 시도는 입력창에만 남았고 별도 Enter 후 제출됐다. 후속 응답은 성공했지만 이 recorder는 나중에 180초 관찰 마감으로 종료했으므로 자연 종료 검증으로 세지 않는다. |
| TUI에서 숫자 선행 자유 입력 | `tui-question-live/tui-evidence.json` | `Type a response`를 선택하고 `2 custom identifier`를 입력해 정확히 `TUI_IDENTIFIER:2 custom identifier`를 받았다. 질문창의 bracketed paste는 효과가 없었고, 관찰에서는 글자별 입력과 별도 Enter가 동작했다. 같은 세션 ID를 유지했다. 유휴 상태의 Ctrl+C 후 종료 코드 0, 관찰 마감 미발생을 확인했다. |
| JSON으로 기존 세션 재개 | `logs/resume-json.json` | `--id ... --json`은 실제로 종료 코드 1과 interactive mode unsupported 오류를 반환했다. |

TUI의 초기 렌더링은 커서 이동, 화면 모드, 색상, 터미널 기능 질의 등을 포함했다. 일반 ANSI 제거로 화면 상태나 대기 중인 질문을 판정하지 않는다. 이 관찰의 tmux 화면과 입력 조작은 사람이 확인한 것이며 자동 화면 해석기의 정확도를 증명하지 않는다.

## 저장 기록과 실시간 상호작용의 관계

실제 생성된 파일은 `sessions/<sessionId>/<sessionId>.json`과 `<sessionId>.messages.json`이었다. 메시지 파일의 최상위는 `version`, `updated_at`, `agent`, `sessionId`, `origin`, `messages`, `system_prompt`를 포함했다. `messages`에는 식별자·역할·시각과 content 배열이 있다.

선택형 질문에서 `tool_use`의 `id`, `name: ask_question`, `input.question`, `input.options`를 확인했고, 응답 후 `tool_result.tool_use_id`가 같은 호출을 가리키며 content가 `BLUE`였다. 따라서 세션과 도구 호출을 연결할 근거가 있다. 다만 다음 이유로 저장 파일만을 실시간 입력 허용의 근거로 삼을 수 없다.

- 일반 실행은 `ask_question` 자체의 승인과 실제 답변을 차례로 요구했다. TUI에서는 같은 도구가 바로 질문 메뉴로 나타났다. 같은 도구 호출에서도 상호작용 단계가 다르다.
- 거절 뒤의 `mistake_limit_reached`는 별도 질문이다. 모델의 `ask_question`만 감지하면 놓친다.
- WSL 종료로 유실된 `choice-pinned`는 manifest에 `pending`과 과거 PID가 남고 recorder의 exit 이벤트가 없다. 파일 상태만으로 프로세스 생존이나 응답 가능성을 보증하지 않는다.
- 소스는 manifest와 메시지 JSON을 전체 덮어쓴다. 이번 166개 snapshot에서는 부분 JSON을 직접 관측하지 않았으므로 부분 쓰기·파일 교체·알림 누락의 복구 검증은 별도로 필요하다.

## 관찰 환경에서 드러난 두 가지 문제

### WSL 수명과 SSH 수명

`ssh wsl`의 ProxyCommand는 `wsl.exe -d Ubuntu-24.04 --exec /usr/bin/nc 127.0.0.1 %p`였다. 초기에는 SSH 연결 후 WSL 상태가 `Stopped`가 되었고, tmux/CLI가 사라져 질문 기록만 남았다. 원격 머신 종료와 단순 SSH 단절을 섞어 측정하지 않도록 이후 시험 동안 임시 `wsl ... sleep 1800` 프로세스로 배포판을 유지했다.

따라서 이번 생존 검증의 조건은 **원격 Linux가 살아 있고 tmux가 CLI를 유지하는 동안 SSH 클라이언트가 사라지는 것**이다. 원격 머신 재부팅 후 진행 중인 프로세스까지 살아 있어야 한다는 요구나 증거는 없다. 기록 기반 재개와 실행 중인 프로세스 재연결은 구분해야 한다.

관찰 종료 시 전용 tmux 세션이 남아 있지 않음을 확인하고, 이번 관찰에서 시작한 임시 WSL 유지 프로세스만 종료했다.

### CLI 버전 변화와 원상 복구

첫 모델 실행 뒤 전역 패키지가 3.0.69에서 3.0.70으로 바뀌고 실행 링크가 사라진 것을 관찰했다. 3.0.70 platform binary는 11,286,848바이트였으며 `--version`이 signal 7로 실패했다. 설치 소스에서 기본 자동 업데이트와 detached 설치 경로는 확인했지만, 개별 업데이트 프로세스를 추적하지 않았으므로 해당 변경의 직접 원인을 확정하지 않는다.

나머지 검증은 별도 경로에 `cline@3.0.69`를 설치해 원래 해시와 일치하는 실행 파일을 고정하고, 업데이트를 환경변수로 억제해 수행했다. 관찰 종료 시 전역 패키지 복구를 시도했으나 npm의 기존 백업 디렉터리 충돌로 설치가 실패했다. 원래 3.0.69의 완전한 npm 백업이 남아 있음을 버전·해시로 확인한 뒤 복원했다. 불완전한 3.0.70 디렉터리는 관찰 루트의 `incomplete-cline-3.0.70`으로 보존했다. 복원된 전역 `cline --version`은 3.0.69, 종료 코드 0이며 실행 파일 해시도 원래와 일치한다. 사용자 전역 자동 업데이트 설정 자체는 변경하지 않았다.

## SDK 구현으로 이어지는 판단

1. SSH 전송·원격 실행 유지·CLI 버전별 해석을 분리한다. tmux는 WSL에서 확인한 실행 유지 후보이며 회사 서버 사용 가능성은 별도 확인한다.
2. PTY 없는 실행을 대화형 연동의 대체 경로로 사용하지 않는다. 소스상 일반 질문이 첫 선택지를 자동 선택할 수 있다.
3. 일반 readline과 TUI를 하나의 입력 규칙으로 취급하지 않는다. 3.0.69에서는 재개와 숫자 선행 자유 입력 때문에 TUI 대응이 필요하다. 글자별 지연 전송은 이번 관찰 방법일 뿐, SDK의 입력 완료 보장은 화면 상태와 명시적인 제출 확인으로 설계해야 한다.
4. 메시지 기록은 읽기 전용으로 사용한다. 실시간 terminal 상태, 세션 ID, 도구 호출 ID, 상호작용 단계, 프로세스 식별 근거를 함께 확인하고 응답을 보낸다.
5. `connected`, `waiting`, `cancelled`, `completed`를 독립 근거로 판정한다. SSH 연결 유무, 완료 문구, 종료 코드 0, manifest의 과거 상태 중 하나만으로 전체 상태를 결정하지 않는다.
6. 실패한 실행도 진단에 보존한다. 버전 변화, 프로세스 종료 누락, 추가 질문, 입력 변환은 성공 기록만으로 발견할 수 없다.

## 아직 완료되지 않은 검증

- 회사 CLI의 버전·저장 형식·화면·입력 방식과 공개 CLI 기준 버전의 관계.
- SDK의 자동 terminal 상태 복원, 질문 중복 제거, 잘못된/오래된 응답 차단과 전달 여부 불명 복구.
- 파일 부분 쓰기·교체·누락 이벤트의 재동기화, 한글·멀티바이트·긴 입력, TUI 입력 수락 확인.
- 재생 도구와 자동 회귀 테스트. 현재 제공한 `summarize.mjs`는 기록 무결성 검사만 수행한다.
- 로컬 웹 예제와 Electron 소비 앱의 실제 SDK 사용. SDK와 GUI 구현은 아직 없다.

다음 구현 단위는 고정된 3.0.69 관찰 자료로 버전별 어댑터와 상태 판정·기록 재생을 검증하는 것이다. 회사 fork를 지원한다고 선언하는 단계와 구분한다.
