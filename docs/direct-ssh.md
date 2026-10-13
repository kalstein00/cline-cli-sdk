# SSH 직접 실행과 제한 사항

현재 live 경로는 **로컬 SDK → OpenSSH → 설치된 tmux → 설치된 Cline CLI**다. Python은 요구하거나 검사하지 않는다. 서버에 Python/셸 파일을 업로드하거나 SDK supervisor를 실행하지 않는다. SSH 요청은 고정된 셸 명령 조합과 인용된 인자로 구성하며 `uname`, `command`, `test`, `printf`, `find`, `head`, `tmux`, Cline을 사용한다. 서버에서 Cline 단일 바이너리만 허용하는 정책이라면 이 구조 역시 사용할 수 없다.

tmux는 사용자별 별도 socket 이름과 `-f /dev/null`을 사용한다. `remain-on-exit`을 CLI 실행 전에 설정하고 CLI 및 프롬프트를 분리된 argv로 전달한다. 셸 인용에 더해 tmux의 끝 세미콜론 인용도 적용한다. 이 동작은 [tmux 공식 매뉴얼](https://man.openbsd.org/tmux.1)의 다중 인자 실행 및 명령 구분자 규칙을 따른다. 일반 `send-keys`, `pipe-pane`, `run-shell`, 임의 명령 실행 인터페이스는 제공하지 않는다.

| 기능 | 이전 supervisor 방식 | 현재 직접 실행 |
|---|---|---|
| 첫 요청 | supervisor가 CLI 시작 | 설치 CLI에 `--cwd`, `--auto-approve false`, 프롬프트 전달 |
| 연결 해제 후 작업 유지 | supervisor + tmux | tmux 유지, SDK close는 로컬 SSH만 종료 |
| 재연결 | 관리 manifest 및 입력 ledger 복구 | 현재 tmux 서버의 SDK 세션 메타데이터 조회 |
| 기존 대화 | 관리 실행에 연결된 JSON | 사용자가 선택한 `<sid>/<sid>.messages.json` 읽기 전용 조회 |
| 실행과 대화 자동 결합 | 프로세스·세션 소유 증거 사용 | 비활성화. 최신 파일/동일 프롬프트로 결합하지 않음 |
| CLI 화면 | PTY 스트림 및 구조화 상호작용 | `capture-pane` 텍스트 조회. 커스텀 하단 레이아웃과 무관 |
| 후속 메시지·질문·승인 응답 | 원격 검증과 ledger | 비활성화. SDK 호출도 `remote-input-disabled`, `notSubmitted: true` |
| 같은 대화 재개 | 소유권 검증 및 입력 ledger | 비활성화 |
| 작업/자식 프로세스 중단 | 프로세스 소유권 추적 | 비활성화. pane 종료를 전체 작업 종료로 해석하지 않음 |
| 완료 및 구조화 JSON 결과 | 이력·프로세스 완료 증거 결합 | live에서 비활성화. 과거 기록 재생/JSON 검증은 유지 |
| 인증·설정 | native 또는 별도 dataDir | native만 사용, 격리 dataDir는 실행 전에 거부 |
| 진단 | PTY 및 입력 수신 확인 기록 | 로컬 JSON/연결 관측의 부분 기록. 완전한 실행 재현을 주장하지 않음 |

## 준비 및 사용

로컬 Node.js 22+, OpenSSH와 원격 Linux의 POSIX 호환 비대화형 셸, tmux 3.2 이상, 설치된 CLI가 필요하다. CLI `--help`에서 `--cwd`, `--auto-approve`를 확인하며 TUI 요청에는 `--tui`도 필요하다. 회사 빌드의 옵션 의미와 실제 동작은 별도 실측 대상이고 `companyCompatibility: unverified`를 유지한다. 인증 및 CLI 설치는 기존 서버 설정을 사용한다.

```js
import {createClient} from '@cline-cli-sdk/sdk';
const client = createClient({mode: 'live', connection: {
  host: 'company-vdi', cliPath: '/installed/path/cline',
  storageMode: 'native', sessionDirectory: '/existing/cline/data/sessions',
}});
const preflight = await client.connect();
if (!preflight.ready) throw new Error(preflight.problems.join(', '));
await client.start({cwd: '/existing/workspace', prompt: '요청 내용',
  terminalMode: 'tui', terminal: {cols: 100, rows: 32}});
const snapshot = await client.refresh(); // remoteObservation.terminalText: 조회 전용
const entries = await client.listManagedExecutions();
// kind === 'history' 항목을 사용자가 선택한 다음:
const saved = entries.find(entry => entry.kind === 'history');
if (saved) await client.attach(saved.executionId);
console.log(client.snapshot().messages);
```

`listManagedExecutions()`의 `kind: history` 항목은 실행 프로세스가 아니다. `identityConfirmed`는 false이며 입력 대상을 승인하지 않는다. `kind: tmux`는 SDK가 만든 pane의 조회 항목이다. `remoteObservation.paneAlive`와 `paneExitCode`도 CLI 하위 프로세스의 생존·종료를 보장하지 않는다. `snapshot.execution`은 확실한 소유/종료 근거가 없어 unknown으로 남는다. `reconfirmDelivery()`는 호환용 조회 메서드이며 메시지 전달을 확정하지 않는다.

`sessionDirectory`를 생략하면 원격 환경의 `CLINE_SESSION_DATA_DIR`, `CLINE_DATA_DIR`, `CLINE_DIR` 및 기본 `~/.cline/data/sessions`를 따른다. 폴더가 아직 없으면 첫 실행은 허용하지만 대화 조회는 사용할 수 없으며 CLI가 폴더를 만든 뒤 재연결해야 한다. 다른 JSON 형식은 추측하지 않고 이력 미확인으로 처리한다. version 1, 일치하는 sessionId, 메시지 구조를 검사하며 손상·부분 쓰기·세션 불일치에는 마지막 정상 메시지를 유지한다. 세션 이름은 영숫자 시작, 영숫자/밑줄/하이픈 128자 이내이며 목록은 256개, JSON 읽기는 8 MiB로 제한한다. 한도 초과 시 일부 목록을 임의 선택하지 않고 오류를 알린다. leaf symlink 및 비정규 파일은 읽지 않는다. 같은 계정에서 동시에 경로를 교체하는 공격에 대한 격리 경계는 아니다.

첫 요청은 SSH 명령 크기를 제한하기 위해 NUL 없이 UTF-8 8,192바이트 이내로 받는다.

터미널 크기는 초기 기본값만 120×40이다. 20–500열, 5–200행의 유효 범위를 허용하고 이후 tmux가 보고한 크기를 읽는다. 화면 위치나 상태줄 문구로 입력을 허용하지 않는다.

## 수동 상호작용과 이전 설치

SDK의 `ManagedExecution.remoteRoot`는 현재 tmux socket 이름이다. 원격 서버의 터미널에서 `tmux -L <remoteRoot> attach-session -t =<executionId>`로 직접 들어가 질문·승인·후속 입력을 처리할 수 있다. SDK에는 이를 대신 입력하는 우회 경로가 없다. `ConnectionOptions.remoteRoot`는 호환을 위해 남겨 둔 목록 구분 키이며 해시된 socket 이름에만 쓰이고 원격 디렉터리를 만들지 않는다.

이전 supervisor 실행과 파일은 자동 종료·삭제·업그레이드하지 않는다. 새 SDK는 이전 프로토콜에 접속하지 않으므로 운영자가 기존 작업을 확인하고 수동으로 정리해야 한다. tmux 서버 종료나 서버 재부팅 후에는 실행 메타데이터가 사라진다. JSON 기록은 남아 있으면 계속 읽을 수 있다.

CLI 실행 요청 도중 SSH가 끊기면 실행 여부 불명으로 보존하고 자동 재시작하지 않는다. tmux 메타데이터 조회로 pane 생성은 다시 확인할 수 있지만 첫 메시지 수신 자체를 증명하지는 않는다. 앱 재시작/새 클라이언트에는 원격 입력 ledger가 없으므로 운영자가 목록을 확인해야 한다. 동일 SSH 계정 권한, CLI가 수행하는 도구 동작, 그 계정의 tmux 접근 권한은 기존과 동일하다. helper 제거가 CLI 자체의 샌드박스를 만드는 것은 아니다.

## 검증 범위

`tests/direct-live.test.mjs`는 SSH 명령 인용, Python/소스 전송 부재, 안전하지 않은 메서드의 무전송 거부, 실행 불명 시 재전송 차단, 재연결, JSON 손상 및 이력 선택을 검증한다. 제거된 supervisor 제어 기능의 성공 테스트는 폐기했으며 재생·내보내기·마스킹 시험은 유지한다. 브라우저 시험은 새 조회 전용 계약으로 교체했다. 실제 VDI의 CLI 옵션·tmux 실행·저장 형식 호환성은 자동으로 인증되지 않는다.

2026-10-13 로컬 검증: 빌드 및 조회·재생·진단 회귀 105개 통과 후 추가 직접 실행 회귀를 포함한 14개, 챗봇 HTTP 계약 1개가 통과했다(합계 서로 다른 109개). 전체/브라우저 E2E는 지정한 완료 이벤트 runner를 시도했으나 codex-internal.ps1 부재로 시작되지 않았다. 실제 tmux/VDI 실행과 브라우저 렌더링은 이번 환경에서 확인하지 못했다.

리뷰 후 최종 관련 회귀 실행: 112개 중 109개 통과, 실제 SSH 환경이 필요한 3개 skip, 실패 0. 화면 변경의 구독 이벤트/revision 누락, 연결 이벤트 도중 취소 경합, Node 예제의 미지원 완료 대기, 웹 예제의 원격 화면 누락을 수정했다. 배포 dry-run의 41개 파일에는 Python/remote helper가 없다. 전체 runner는 동일한 필수 스크립트 부재로 시작되지 않았다.

알려진 호환성 제한: stderr 도움말은 4,096자까지만 보존하므로 그 뒤에만 나오는 필수 옵션은 누락으로 판정되어 실행이 차단될 수 있다. 이는 옵션 검증을 우회하지 않으며 긴 stderr 도움말을 출력하는 회사 포크는 별도 확인이 필요하다.
