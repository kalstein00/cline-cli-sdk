# WSL Cline 3.0.69 설치 소스 조사

2026-10-09 설치된 npm 패키지와 Linux 실행 파일에 포함된 JavaScript를 읽었다. 실제 모델 실행 결과는 별도 관찰 문서에서 다룬다. 회사 fork의 기능이나 저장 형식은 이 결과로 확정하지 않는다. 자격 증명 파일, provider 설정 내용, 기존 사용자 세션 기록은 읽지 않았다.

## 조사 대상과 근거 표기

원격 패키지 루트는 `/home/kalstein/.local/share/fnm/node-versions/v22.22.0/installation/lib/node_modules/cline`이다. 아래 경로는 모두 이 루트 기준이다. 압축된 JavaScript의 한 줄이 길므로 줄 번호와 검색할 함수 이름을 함께 제시한다. Bun 실행 파일의 JavaScript는 실행하지 않고 바이트로 읽었으며, 위치는 파일 시작 기준 0-based byte offset이다.

| 참조 | 경로 | SHA-256 |
|---|---|---|
| P | `package.json` | `27fe3e8cec73d46af9394f1f5a862f6cfc4f53b99283af3a8285717087d08254` |
| C | `node_modules/@cline/core/dist/index.js` | `bde6829402b676a2ccc1844939b383e2748e077817d49b5ce642c8100eded145` |
| S | `node_modules/@cline/shared/dist/storage/index.js` | `e1ccb9cef5170b418f808c252a94ee846acc852f2464330d46b5656144feb968` |
| B | `node_modules/@cline/cli-linux-x64/bin/cline` | `8ddf33048e9e4418d89aabe2792ceac83d3905b83b18ae21fed2f4f890c37032` |

P는 CLI `3.0.69`, `@cline/core`, `@cline/sdk`, `@cline/shared` 의존성 `0.0.91`을 명시한다. 패키지가 가리키는 원본 저장소는 [cline/cline](https://github.com/cline/cline), 디렉터리는 `apps/cli`다. 이 문서는 현재 upstream HEAD를 설치 버전의 소스라고 가정하지 않으며 위 설치 파일을 근거로 한다.

조사 후 같은 package.json이 `3.0.70`으로 바뀐 것을 관찰했다(SHA-256 `040944f897fb836a6a6ada1b749dfd3f797853b54e4156ed19f878ba7955b8dd`). 당시 platform binary는 11,286,848바이트였고 기존 embedded JavaScript 검색 결과가 없어 이 파일을 완성된 3.0.70 실행물로 검증하지 않았다. 변경 원인은 이 조사에서 확인하지 않았다. 아래 offset과 동작 해석은 앞서 해시를 계산한 **3.0.69**에만 해당한다. 이 연구 작업은 원격 파일을 변경하지 않았다.

후속 소스 확인은 별도로 준비된 `/home/kalstein/cline-sdk-observe-20261009-9qzzex7j/cli-pinned/node_modules/@cline/cli-linux-x64/bin/cline`을 읽었다. 크기 130,471,392바이트이고 SHA-256은 위 B와 동일했다. 따라서 아래 기존 offset은 이 고정 사본에서도 유효하다.

## 자동 업데이트와 재현 가능한 관찰

CLI startup 함수 `Pt()`는 argv 파싱 및 `--config` 적용 **이전**에 `Xv()`를 호출한다. `Xv()`는 `CLINE_NO_AUTO_UPDATE === "1"`이면 즉시 반환한다. 그 외에는 개발 모드 여부와 global 설정 `autoUpdateEnabled`를 확인한 뒤 최신 버전을 조회한다. 이 설정의 기본값은 `true`다. [B: 93229601 부근 `Pt`; 93218679 `Xv`; 85682307 부근 설정 스키마]

조회 결과 업데이트가 필요하면 업데이트 명령을 보관하고, `v4()`는 활성 CLI 클라이언트/세션 검사 뒤 detached shell 프로세스로 해당 명령을 실행할 수 있다(`stdio: "ignore"`). [B: 93219581 `v4`]

따라서 실측 시에는 **프로세스 시작 전 `CLINE_NO_AUTO_UPDATE=1`을 지정**하고 실행 파일 해시를 고정한다. `--data-dir`만으로 이 동작을 차단했다고 볼 수 없다. 이 소스는 자동 업데이트 경로가 존재함을 확인하지만, 앞서 관찰한 3.0.70 변경의 직접 실행 주체는 프로세스/로그 근거 없이 단정하지 않는다.

## JSON 출력과 사용자 입력

- `--json`은 `outputMode: "json"`을 설정한다. `--tui`는 별도로 `interactive`를 설정한다. 대화형 진입 검사 `qe()`는 두 옵션을 함께 사용하면 `interactive mode is not supported with --json`으로 종료한다. 입력 JSON 프로토콜로 취급하면 안 된다. [B: 92932329의 `fH`, 95530433 부근의 `qe`]
- `--id`를 지정하면 startup target을 `chat`으로 변경하고 `interactive: true`, `prompt: undefined`로 설정한다. 따라서 일회 실행 프롬프트를 기존 세션에 보내는 옵션으로 해석할 수 없으며 `--id --json`도 대화형 검사 대상이다. [B: 93240837 부근]
- 일반 실행의 질문 처리 함수 `e0(question, options)`는 stdin/stdout이 모두 TTY가 아니면 **첫 옵션 또는 빈 문자열을 즉시 반환**한다. 파이프 실행의 성공을 사용자 질문 왕복의 성공으로 판단하면 안 된다. [B: 95488217 부근]
- TTY에서 질문은 `[follow-up] <question>`, `1. <option>` 등의 번호 목록, `Choose 1-N or type a custom answer:`, `>`로 출력한다. 한 줄을 받아 공백을 제거하고, 유효한 번호면 해당 선택지, 그 외 비어 있지 않은 문자열이면 사용자 답변, 빈 줄이면 첫 선택지를 반환한다. 번호 판정에 `parseInt`를 사용하므로 SDK에서는 자유 입력이 숫자로 시작할 때의 의미를 따로 관찰해야 한다. [동일 `e0`]
- 설치 core의 실제 `ask_question` 스키마는 비어 있지 않은 질문과 **2~5개 선택지**를 요구한다. 자유 입력은 같은 선택형 질문의 custom answer 경로로 관찰할 수 있다. 선택지 없는 별도 질문 유형은 이 스키마에서 확인되지 않았다. [C: 55행 `au`, 119행 `mk`]
- 일반 실행의 승인 함수 `H()`는 TTY에서 `Approve "<toolName>" <input> [y/N]`를 표시한다. `y`, `yes`만 승인하며 다른 입력은 거절한다. 표시용 input은 JSON을 160자로 줄여 사용할 수 있으므로 화면 문자열만으로 전체 도구 인자를 복원하면 안 된다. TTY가 아니면 승인을 거절한다. [B: 95487200~95488217]
- TUI는 별도의 `tuiToolApprover` 및 `tuiAskQuestion` 콜백을 등록한다. 일반 readline 질문 형식을 TUI에도 그대로 적용하면 안 된다. [B: 95522200~95526000, 95549000~95551800]

## 격리 경로와 인증

`--data-dir`은 단순한 세션 폴더 변경이 아니다. CLI의 `lp()`는 sandbox를 활성화하고 `CLINE_DATA_DIR`, `CLINE_DB_DATA_DIR`, `CLINE_SESSION_DATA_DIR`, `CLINE_TEAM_DATA_DIR`, `CLINE_PROVIDER_SETTINGS_PATH`, `CLINE_HOOKS_LOG_PATH`를 지정 디렉터리 아래로 설정한다. 사전에 설정한 provider 경로도 이 함수가 덮어쓴다. [B: 92941707~92942150]

기본 provider 경로는 `<data-dir>/settings/providers.json`, global 설정은 `<data-dir>/settings/global-settings.json`, MCP 설정은 `<data-dir>/settings/cline_mcp_settings.json`이다. 세션과 DB 경로를 각각 덮어쓰는 환경변수도 있지만 그것만으로 다른 설정·로그까지 격리됐다고 볼 수 없다. 규칙·스킬·후크의 검색 경로는 별도로 `.cline`, `.agents` 등을 참조하므로 data-dir 격리는 프로세스의 파일 접근 sandbox라는 뜻이 아니다. [S: 1행 `p`, `be`, `d`, `Be`, `Xe`, `Ze`, `er`, `rr`, `nr`]

ProviderSettingsManager는 provider 설정과 `auth`를 providers.json에 저장한다. OAuth 갱신 결과도 같은 manager의 `saveProviderSettings()`로 저장한다. 별도 `auth.json`, `oauth.json`, keyring 경로는 조사한 core에서 확인하지 못했다. 다른 provider의 환경변수나 외부 인증 체계까지 없다는 뜻은 아니다. [C: 683~684행 `yt`, `saveProviderSettings`, `oauth.resolve`]

기존 인증으로 격리 시험을 수행하려면 필요한 설정을 격리 디렉터리로 복사하는 방식이 원본 파일 쓰기를 피한다. 단, OAuth 갱신은 원격 토큰 상태에 영향을 줄 수 있으므로 파일 복사만으로 계정까지 완전히 독립되는 것은 아니다. 인증 파일은 원문 출력·진단 반출 대상에서 제외해야 한다. 이는 소스에서 도출한 운용상의 구분이며 이번 소스 조사에서는 복사나 인증을 실행하지 않았다.

## 세션 기록

기본 경로는 `<data-dir>/sessions/<sessionId>/`이며 다음 파일을 사용한다. legacy `tasks/<id>/ui_messages.json`을 이 버전의 기본 형식으로 가정하면 안 된다. [S: 1행 `be`; C: 557행 `Cy`]

| 파일 | 확인한 구조 |
|---|---|
| `<sessionId>.json` | `version: 1`, `session_id`, `source`, `pid`, `started_at`, `ended_at?`, `exit_code?`, `status`, `interactive`, `provider`, `model`, `cwd`, `workspace_root`, 도구 활성화 설정, `prompt?`, `metadata?`, `messages_path?` |
| `<sessionId>.messages.json` | `version: 1`, `updated_at`, `agent`, `sessionId`, `origin`, `messages` 배열, `system_prompt?` |
| `<sessionId>.compaction.json` | 별도의 압축 상태 sidecar; manifest에서 `compaction_path`를 참조할 수 있음 |

Manifest와 message envelope 생성은 C 536~537행의 `LR`, `Kh`, `OR`에 있다. 메시지 reader `kr()`는 envelope의 `messages`와 legacy 최상위 배열을 모두 받아들이며 읽기·파싱 오류는 빈 배열로 처리한다. SDK가 그 동작을 그대로 복제하면 일시적인 쓰기 중 파싱 실패를 기록 삭제로 오해할 수 있다.

`writeSessionManifest()`와 `persistSessionMessages()`는 JSON 전체를 `writeFileSync`로 덮어쓴다. 압축 sidecar는 별도 원자적 쓰기 함수 `eE()`를 사용한다. 따라서 manifest/messages 관측자는 파일 교체·부분 읽기·일시적 파싱 실패를 고려하고 마지막 정상 snapshot을 보존해야 한다. [C: 558~561행 `ky`, `persistSessionMessages`; 557~558행 `eE`]

세션 manifest는 기록과 프로세스 상태의 단서다. 파일의 존재나 `pid`만으로 현재 질문의 응답 대상, 승인 전달 완료, 프로세스 생존을 확정할 근거는 이번 소스 조사에서 얻지 못했다.

## 중단과 재개

일회 실행은 첫 SIGINT 또는 SIGTERM에 runtime `abort()`를 요청한다. 두 번째 SIGINT는 shutdown 이후 프로세스 종료를 진행한다. 정상 shutdown에서 runtime `stop()`과 `dispose()`를 호출한다. JSON 모드에서는 `run_abort_requested`, `run_result`, `run_aborted` 등의 출력 경로가 있다. [B: 95507400~95509900]

TUI의 `onAbort`는 `abortAll()`에 연결되고, `onExit`는 화면 renderer 종료에 연결된다. `onResumeSession`은 별도의 세션 복구 동작이다. 이 구분은 연결 해제, 작업 중단, 화면 종료를 별도 동작으로 설계해야 한다는 근거지만, SSH 단절 시 생존이나 실행 중 자식 명령의 종료를 증명하지는 않는다. [B: 95549000~95551800]

후속 실측에서는 일반 PTY의 선택 응답·custom answer·승인/거절, TUI 재개, tmux 유지 중 SSH 단절, 명시적 중단 후 기록 보존을 각각 확인해야 한다. 저장 형식만 맞추는 것으로 회사 fork의 호환성을 선언할 수 없다.
