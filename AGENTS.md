# Personal Agent Notes

- When invoking the Codex CLI from inside a Codex-run shell command, use `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\kalst\.codex\scripts\codex-internal.ps1 ...` instead of calling `codex ...` directly. This suppresses nested Codex completion notifications while preserving normal outer-session notifications.

## Agent skills

### Issue tracker

이슈와 스펙은 GitHub Issues에서 관리한다. 이슈 작업 전에 `docs/agents/issue-tracker.md`를 읽는다.

### Triage labels

다섯 가지 기본 triage 라벨을 사용한다. 라벨 적용 전에 `docs/agents/triage-labels.md`를 읽는다.

### Domain docs

단일 컨텍스트 구조를 사용한다. 코드 탐색 전에 `docs/agents/domain.md`의 문서 소비 규칙을 읽는다.
