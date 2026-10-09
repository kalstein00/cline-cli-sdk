# Issue tracker: GitHub

이 저장소의 이슈와 스펙은 `kalstein00/cline-cli-sdk`의 GitHub Issues에서 관리한다.
모든 이슈 작업에는 `gh` CLI를 사용한다.

## Conventions

- 생성: `gh issue create --repo kalstein00/cline-cli-sdk --title "..." --body-file <path>`
- 조회: `gh issue view <number> --repo kalstein00/cline-cli-sdk --json number,title,body,labels,comments`
- 목록: `gh issue list --repo kalstein00/cline-cli-sdk --state open --json number,title,body,labels`
- 수정: `gh issue edit <number> --body-file <path>`
- 댓글: `gh issue comment <number> --body-file <path>`
- 라벨: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- 종료: `gh issue close <number> --comment "..."`

여러 줄 본문은 UTF-8 임시 파일에 작성하고 `--body-file`로 전달한다.
저장소 밖에서 실행할 때도 `--repo kalstein00/cline-cli-sdk`를 명시한다.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill operations

- "publish to the issue tracker": GitHub 이슈를 생성한다.
- "fetch the relevant ticket": 해당 GitHub 이슈의 본문, 라벨, 댓글을 읽는다.

## Wayfinding operations

- Map: Notes / Decisions-so-far / Fog를 담은 `wayfinder:map` 이슈.
- Child ticket: map의 GitHub sub-issue로 연결하고 `wayfinder:<type>` 라벨을 적용한다.
  type은 `research`, `prototype`, `grilling`, `task` 중 하나다.
- Sub-issue API를 사용할 수 없으면 부모 본문에 작업 목록을 추가하고
  자식 본문 첫머리에 `Part of #<parent>`를 기록한다.
- Blocking: GitHub native issue dependencies를 사용한다.
  `gh api --method POST repos/kalstein00/cline-cli-sdk/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`
  database ID는 `gh api repos/kalstein00/cline-cli-sdk/issues/<number> --jq .id`로 조회한다.
  API를 사용할 수 없으면 자식 본문 첫머리에 `Blocked by: #<number>`를 기록한다.
- Frontier: map 순서대로 열린 자식 중 열린 blocker와 assignee가 없는 첫 이슈를 선택한다.
- Claim: `gh issue edit <number> --add-assignee @me`.
- Resolve: 결과 댓글을 작성하고 이슈를 닫은 뒤 map의 Decisions-so-far에 요약과 링크를 추가한다.

추가 wayfinder 라벨은 해당 워크플로를 사용할 때 생성한다.
