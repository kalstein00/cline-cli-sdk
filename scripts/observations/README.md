# 관찰 보조 도구

이 도구는 2026-10-09 WSL Cline 3.0.69 실측에 사용한 실험용 코드다. SDK, 자동 terminal 해석기, 회사 CLI 지원 수집기는 아직 아니다. 결과와 실행 조건은 [실측 문서](../../docs/observations/cline-3.0.69-live-compatibility.md)를 참고한다.

| 파일 | 역할 |
|---|---|
| `remote_probe.py` | Linux PTY에서 명시한 argv를 실행하고 입출력 바이트·격리 세션 파일 snapshot을 기록한다. 외부에서 FIFO로 입력을 전달한다. |
| `scenario_probe.py` | 고정 CLI와 격리된 데이터 경로가 준비된 관찰 루트에서 승인·거절·숫자 선행 입력·중단 사례를 실행한다. 실제 모델을 호출한다. |
| `drop_ssh_client.mjs` | 지정한 관찰 tmux 세션에 SSH로 붙은 뒤 자신이 만든 Windows SSH 프로세스 트리만 종료한다. 물리 네트워크 장애 시뮬레이터는 아니다. |
| `summarize.mjs` | Windows로 복사한 기록의 해시·이벤트 순서·snapshot 경로와 JSON 상태를 검사한다. 기록을 SDK에 입력해 동작을 재생하는 도구는 아니다. |

로컬 기록 검사:

```powershell
node scripts/observations/summarize.mjs .observations/20261009
```

이번 실행의 원격 루트는 `/home/kalstein/cline-sdk-observe-20261009-9qzzex7j`였다. 관찰용 인증 사본은 이미 제거했으므로 모델 실행 명령을 그대로 다시 실행하면 인증이 준비되어 있다고 가정할 수 없다. 재실행 시 새 격리 루트와 실행 이름, 해당 환경의 인증, 고정 실행 파일, `CLINE_NO_AUTO_UPDATE=1`을 명시적으로 준비해야 한다. `scenario_probe.py`는 이 회차의 고정 실행 파일명과 세션 저장 형식을 전제로 하므로 다른 CLI 버전에 그대로 적용하지 않는다.

관찰 당시 거절 driver는 추가 `mistake_limit_reached` 질문에서 대기가 만료돼 수동으로 종료 선택지를 보냈다. 이후 driver에 해당 분기를 추가했으며 수정된 분기의 종단 재실행은 하지 않았다. 실측 근거는 최종 helper 코드가 아니라 해시로 고정한 원문 기록이다.

원문 기록은 `.observations/` 아래 보관하고 Git에서 제외한다. 보고서와 코드만 저장소의 추적 대상으로 둔다. 인증 설정은 recorder의 snapshot 허용 경로에 포함하지 않는다.
