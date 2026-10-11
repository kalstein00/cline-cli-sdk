# cline-cli-sdk
An unofficial SDK for integrating remote Cline CLI sessions into applications over SSH.

`@cline-cli-sdk/sdk`를 소비하는 독립 챗봇 예제를 구현했습니다. Node.js 22 이상에서 실행합니다.

```powershell
npm ci
npm run example:chat
```

브라우저에서 [챗봇](http://127.0.0.1:4174)을 엽니다. 기존 [테스트 GUI](http://127.0.0.1:4173)는 `npm run example:web`으로 실행하며 SDK 진단·재생을 개별 확인하는 용도입니다.

- [연결 준비, 다른 프로젝트 독립 설치와 공개 API 적용 안내](examples/chat/README.md)
- [실제 브라우저/공개 CLI 수용과 회귀·장애 주입 결과](docs/chat-acceptance.md)

후속/재개 입력은 UTF-8 112바이트의 한 줄입니다. 회사 Cline fork는 미검증이며 공개 CLI 수용과 구분합니다. npm 공개 게시와 제품 앱 통합은 수행하지 않았습니다.

아래 설계 메모는 초기 관찰 당시 기록입니다. 현재 구현·검증 결과는 위 수용 문서에서 확인합니다.
