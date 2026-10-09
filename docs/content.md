# think와 구조화 결과

회사 CLI는 사용자 확인으로 `--zen` 미지원, `--json` 지원이다. 정확한 버전·실행 파일·출력 자료는 아직 없어 회사 프로필은 미검증이다. `ConnectionOptions.declaredFeatures`로 이 정보를 전달해도 실행 파일 식별이나 입력 경로 검증을 생략하지 않는다.

`preflight().features`와 `capabilities().features`는 기능별 지원 상태와 근거(`verified-profile`, `help`, `declared`, `unobserved`)를 반환한다. CLI의 `--json` 옵션, JSON 모드의 질문 응답·재개, 메시지 thinking, 모델의 네이티브 JSON Schema 생성 강제는 별도 기능이다. `outputModes`는 SDK에서 실제 선택 가능한 출력 모드다. 예제의 기능 패널과 모드 선택은 같은 공개 계약을 사용한다.

현재 관리 실행은 `--zen`을 사용하지 않는다. 연결 해제·닫기는 원격 작업 중단이 아니며 실행 유지에는 기존 Python·PTY·tmux 및 프로세스 소유 확인 조건을 사용한다. 알 수 없는 회사 실행 파일은 관측된 옵션만 보고하고 조작을 허용하지 않는다. 회사 실측은 #13에서 관리한다.
