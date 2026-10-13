# Live 연결

현재 구현은 [SSH 직접 실행과 제한 사항](direct-ssh.md)을 따른다. Python 설치나 supervisor 배포는 필요하지 않다. 원격 Linux, tmux 3.2+, 설치된 Cline CLI와 비대화형 SSH 인증이 필요하다. SSH 호스트 키 검증은 끄지 않는다.

CLI 경로는 비대화형 SSH PATH에서 찾거나 절대 경로로 지정한다. 로그인 셸 초기화 파일을 실행하여 경로를 추측하지 않는다. 작업 폴더는 이미 존재해야 하며 SDK가 만들지 않는다. 원격 저장은 기존 Cline native 환경을 사용한다.

120×40은 초기 기본 크기일 뿐이다. start.terminal로 다른 크기를 지정할 수 있고 refresh는 실제 tmux 크기를 읽는다. 조회 화면의 입력창이나 footer는 원격 입력 허용 근거로 사용하지 않는다.

과거 supervisor 기반 성공 기록은 Git 이력 및 fixtures에 보존되어 있으며 현재 live 경로의 보장을 뜻하지 않는다.
