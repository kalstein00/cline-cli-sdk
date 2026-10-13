# cline-cli-sdk
An unofficial SDK for integrating remote Cline CLI sessions into applications over SSH.

설치된 Cline CLI를 SSH/tmux로 직접 실행하며 Python 업로드·원격 supervisor를 사용하지 않습니다. 첫 요청 실행, 화면 조회, 기존 JSON 대화 읽기를 제공합니다. 후속 입력·질문/승인 응답·재개·중단은 비활성화합니다. Node.js 22 이상에서 실행합니다.

현재 계약과 이전 대비 제한은 [SSH 직접 실행 안내](docs/direct-ssh.md)를 확인하세요.

```powershell
npm ci
npm run example:chat
```

브라우저에서 [챗봇](http://127.0.0.1:4174)을 엽니다. 기존 [테스트 GUI](http://127.0.0.1:4173)는 `npm run example:web`으로 실행하며 SDK 진단·재생을 개별 확인하는 용도입니다.

- [연결 준비, 다른 프로젝트 독립 설치와 공개 API 적용 안내](examples/chat/README.md)
- [실제 브라우저/공개 CLI 수용과 회귀·장애 주입 결과](docs/chat-acceptance.md)
- [SDK 생성 중 답변과 챗봇 스트리밍 표시](docs/streaming.md)
- [Windows WSL SSH 배너 오류 수정과 프록시 설정](docs/wsl-ssh.md)
- [기존 인증·설정·기록을 사용하는 설치 CLI 지원과 실제 WSL 관측](docs/observations/wsl-native-storage.md)

회사 Cline fork는 미검증입니다. 아래 과거 수용 기록은 현재 직접 실행 기능의 검증 결과가 아닙니다. npm 공개 게시와 제품 앱 통합은 수행하지 않았습니다.

아래 설계 메모는 초기 관찰 당시 기록입니다. 현재 구현 계약은 SSH 직접 실행 안내에서 확인합니다.

설계 범위를 합의하고 WSL의 공개 Cline 3.0.69에서 실제 질문·응답, 승인·거절, SSH 클라이언트 상실 후 복구, 작업 중단과 세션 재개를 관찰했다. SDK·GUI 구현과 회사 CLI 호환성 검증은 아직 수행하지 않았다.

- [용어집](GLOSSARY.md)
- [Node.js SDK와 로컬 웹 예제 앱](docs/adr/0001-node-sdk-and-browser-example.md)
- [연결과 원격 작업의 수명 분리](docs/adr/0002-remote-work-survives-disconnection.md)
- [불확실한 응답 전달과 질문 해석 시 조작 차단](docs/adr/0003-uncertain-interactions-block-input.md)
- [WSL 개발과 회사망 테스트의 진단 피드백](docs/adr/0004-wsl-development-and-company-feedback.md)
- [WSL CLI 사전 관찰](docs/observations/wsl-cli-preflight.md)
- [Cline 3.0.69 설치 소스 조사](docs/observations/cline-3.0.69-source-findings.md)
- [Cline 3.0.69 실제 연동 관찰과 지원 한계](docs/observations/cline-3.0.69-live-compatibility.md)
