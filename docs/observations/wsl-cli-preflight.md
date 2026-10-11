# WSL CLI 사전 관찰

2026-10-09 현재 Windows 개발 PC에서 `ssh wsl`을 통해 읽기 전용으로 확인했다. 이 문서는 개발 환경의 관찰 결과이며 회사 CLI의 호환성 검증 결과가 아니다.

## 접속과 실행 환경

- `BatchMode=yes`, `StrictHostKeyChecking=yes`, `ConnectTimeout=10`의 첫 접속은 SSH 배너 교환 단계에서 시간 초과했다.
- 같은 별칭에 `ConnectTimeout=30`으로 재확인한 접속은 성공했고 원격 `uname -s`는 `Linux`를 반환했다. 첫 시간 초과의 원인은 조사하지 않았다.
- 비대화형 SSH 명령에서는 Node `v18.19.1`, npm `9.2.0`, tmux `3.4`를 확인했다. 해당 셸의 PATH에서는 `cline`을 찾지 못했다.
- `bash -lic`로 확인한 로그인 환경에서는 fnm이 제공하는 Node `v22.22.0`, npm `10.9.4`, Cline `3.0.69`를 확인했다.
- 따라서 CLI가 없다고 판단할 수 없으며, 원격 실행 시 사용할 Node와 CLI 경로를 셸 환경과 함께 확인해야 한다. 관찰된 fnm 경로는 셸마다 달라질 수 있는 임시 경로이므로 실행 설정에 그대로 고정하지 않는다.

로그인 환경 확인 명령:

```powershell
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=30 wsl "bash -lic 'command -v node; node --version; command -v npm; npm --version; command -v cline; if command -v cline >/dev/null 2>&1; then cline --version; cline --help; fi'"
```

비대화형 SSH에서 대화형 Bash를 열었기 때문에 job control 관련 경고가 출력되었다. 버전과 도움말 조회는 종료 코드 0으로 완료했다. 이 명령을 제품의 최종 실행 방식으로 결정한 것은 아니다.

## 도움말에서 확인한 기능

WSL Cline `3.0.69`의 `--help`에는 다음 옵션이 있다. 옵션 존재만 확인했으며 실제 기능은 실행하지 않았다.

| 옵션 | 도움말에 표시된 의미 |
|---|---|
| `--json` | 메시지를 JSON으로 출력 |
| `--tui` | 대화형 TUI 실행 |
| `--id <session-id>` | 기존 세션 재개 |
| `--cwd <path>` | 작업 디렉터리 지정 |
| `--data-dir <path>` | 분리된 로컬 상태 경로 사용 |
| `--auto-approve <boolean>` | 도구 자동 승인 설정, 기본값 `true` |
| `--acp` | ACP 모드 |
| `--zen` | background hub에서 세션 실행 |

첨부 기획 자료의 회사 CLI는 SDK·ACP를 지원하지 않는 수정 불가 fork다. WSL 버전의 ACP, hub, JSON 출력 등의 옵션을 회사 버전에 그대로 적용할 수 있다고 가정하지 않는다. JSON 출력 옵션의 존재만으로 질문에 응답하는 구조화된 입력 API가 있다고 판단하지 않는다.

질문·승인 왕복을 조사할 때는 WSL CLI가 기본 자동 승인 상태로 실행되어 승인 관찰을 건너뛰지 않도록 실행 옵션을 명시해야 한다. 회사 CLI의 대응 옵션과 기본값은 별도 확인 대상이다.

## 아직 확인하지 않은 내용

- 일반 답변, 선택형 질문, 자유 입력, 승인·거절의 실제 출력과 입력 방식.
- 세션 파일의 위치·형식·갱신 방식과 CLI 버전별 차이.
- tmux 등 실행 유지 후보에서의 연결 단절, 재접속, 작업 중단, 기록 복구.
- CLI 프로세스 종료와 SSH 단절을 구분하는 실제 관측 근거.
- SDK의 진단 수집과 기록 재생. SDK 구현은 아직 없다.
- 회사망 CLI의 버전, 공개 기준 버전과의 관계, 호환성.

이 조사에서는 실제 모델 작업, 설치, SSH 설정 변경, 원격 실행 유지 서비스 구성은 수행하지 않았다.
