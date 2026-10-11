# 생성 중 답변 미리보기

`Snapshot.streaming`은 지원하는 TUI 화면에서 관측한 생성 중 답변이다. 값은 `{turnId, text, truncated}` 또는 `null`이며 지원하지 않는 기록에는 생략할 수 있다. `turnId`는 같은 생성 구간의 표시 식별자이며 저장된 message ID가 아니다. 사용자 메시지와 답변이 완료 때까지 history에 쓰이지 않는 CLI도 지원한다.

```javascript
const unsubscribe = client.subscribe(event => {
  if (event.type === 'state.changed' || event.type === 'message.upsert') {
    const {messages, streaming} = client.snapshot();
    renderConversation(messages);
    renderAnswerPreview(streaming); // null이면 임시 카드를 제거한다.
  }
});
// 기존 live 관측 루프에서 await client.refresh()를 호출한다.
```

SDK가 PTY 프레임을 해석할 때 미리보기 변경을 `state.changed`로 발행한다. 원격 CLI의 토큰 API가 아니라 실제 TUI 출력의 점진적 관측이다. 챗봇 서버는 겹치지 않는 200ms 관측 타이머와 SDK 구독을 사용해 SSE를 전달한다. 이는 테스트 프로세스의 실행 감시 폴링과 별개다.

미리보기는 최대 65,536 JavaScript 문자다. 답변이 화면 밖으로 스크롤되면 정확하게 겹치는 행을 연결하고, 연결을 확인하지 못한 화면 갱신은 마지막 미리보기와 `truncated=true`를 유지한다. 모델의 Thinking/Working 상태 문구, 도구 승인, 질문 및 지원하지 않는 모달을 답변으로 취급하지 않는다. 완료된 assistant 기록이 도착하거나 질문·도구 실행·중단으로 전환하면 미리보기를 제거한다. 같은 문장의 후속 요청도 이전 답변과 별도 생성 구간이다.

`messages`, 응답 receipt, 입력 준비 상태는 기존 관측 근거를 유지한다. 미리보기 내용이나 마지막 문장만으로 `delivered`, 완료 또는 입력 가능을 판정하지 않는다. 회사 fork의 TUI 형식은 별도 수용 검증이 필요하며 CLI 버전을 조회하거나 비교하지 않는다.

`fixtures/streaming/actual-tui-answer.json`은 시험 소유 실행에서 공개 SDK 진단으로 캡처한 30문장 답변이다. 공개 replay 시험은 history 이전에 여러 증가분이 노출되는지, 완료 후 한 개의 최종 메시지로 정리되는지, 같은 요청의 두 번째 구간도 표시되는지 검증한다. 브라우저 시험은 실제 SDK→예제 서버→SSE→DOM 경로를 사용한다.
