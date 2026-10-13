# 소비 앱 시작과 현재 SDK 계약

현재 계약은 [SSH 직접 실행과 제한 사항](direct-ssh.md)이다. 원격 Python helper는 제거했으며 native 저장 방식만 지원한다. Node.js 22 이상에서 다음을 실행한다.

```powershell
npm ci
npm run example:chat
```

[로컬 챗봇](http://127.0.0.1:4174)에서 SSH 별칭, 설치된 CLI 경로, 기존 작업 폴더를 지정한다. 첫 요청은 CLI 시작 인자로 전달한다. 실행을 선택하면 tmux 화면을 읽고, 저장 기록 항목을 선택하면 JSON 대화를 읽는다. 질문/승인 응답과 후속 요청은 원격 CLI에서 직접 처리한다. 입력·재개·중단 버튼은 SDK capability와 함께 차단된다.

다른 프로젝트에 설치하려면 먼저 빌드하고 패키지를 만든다. 패키지에는 로컬 dist만 포함하고 remote Python 디렉터리를 포함하지 않는다.

```powershell
npm run build
npm pack --workspace @cline-cli-sdk/sdk --pack-destination $env:TEMP
```

SDK 사용 예, 크기/읽기 한도, 수동 tmux 접근, 이전 설치 정리, 현재 제한은 [직접 실행 안내](direct-ssh.md)에 정리했다. 진단은 명시적으로 시작하는 로컬 부분 기록이며 원격 제어·메시지 수신 확인을 복원하지 않는다. 과거 재생과 진단 내보내기 기능은 계속 사용할 수 있다.
