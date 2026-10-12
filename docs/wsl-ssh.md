# Windows 개발용 WSL SSH 프록시

`Host wsl`의 `ProxyCommand wsl.exe ... /usr/bin/nc ...`에서 간헐적으로 `banner exchange: Connection to UNKNOWN port 65535: invalid format`이 발생했다. 읽기 전용 공개 SDK 연결을 3개 동시에 실행하는 회귀 시험으로 재현했다. 입력을 비운 SSH에서도 실패했으므로 SDK JSON 입력이 원인은 아니었다.

실패한 WSL 실행에서는 `Wsl/Service/WSAENOBUFS` 진단이 UTF-16 stdout으로 나왔다. 기존 프록시는 이 바이트를 SSH 서버 배너로 전달했다. 같은 서버의 WSL IPv4로 직접 연결한 동시 요청 3개는 통과했다. [Microsoft WSL의 관련 보고](https://github.com/microsoft/WSL/issues/41242)도 새 실행 세션의 WSAENOBUFS를 다루지만, 이 PC의 WSL 내부 장애 원인까지 확정하지는 않았다.

## 적용

Node.js 22 이상과 Windows OpenSSH를 사용하는 로컬 개발 환경용이다. SDK는 일반 OpenSSH 설정을 그대로 사용한다. 저장소를 유지할 위치에 둔 다음, 기존 SSH 설정 파일을 백업하고 `Host wsl`의 ProxyCommand만 다음과 같이 교체한다. Node와 저장소 경로, 배포판 이름은 실제 환경에 맞춘다.

```sshconfig
Host wsl
    ProxyCommand "C:\Program Files\nodejs\node.exe" "C:\Users\kalst\vscode\cline-cli-sdk\scripts\wsl-ssh-proxy.mjs" Ubuntu-24.04 %p
```

기존 HostName, User, Port, IdentityFile, IdentitiesOnly와 호스트 키 검증 설정은 유지한다. 스크립트를 이동하면 ProxyCommand 경로도 수정해야 한다. 설치된 Cline의 버전 조회나 비교는 필요하지 않다.

프록시는 `%TEMP%/cline-sdk-wsl-ssh`에 배포판별 IPv4 주소를 저장한다. 저장된 주소로 TCP 연결이 가능하면 `wsl.exe`를 실행하지 않는다. 주소가 없거나 TCP 연결이 실패하면 배포판별 잠금 아래 `wsl.exe -d <배포판> --exec hostname -I`로 배포판을 기동하고 주소를 확인한다. 그 뒤 SSH 바이트만 TCP로 전달하며 WSL 진단은 stderr로 보낸다. 여러 프록시의 주소 확인은 직렬화한다. 주소 확인 8초, TCP 연결 2초, 잠금 대기 15초의 제한을 둔다.

잠금에는 생성 시각과 소유 프록시 PID를 기록한다. JSON이 비었거나 손상됐거나 유효한 시각이 없으면 파일 수정 시각으로 나이를 판단한다. 20초가 지나고 소유 프로세스가 없으면 남은 잠금을 정리한다. 소유 프로세스가 살아 있거나 생존 여부를 확인할 수 없으면 잠금을 유지하며 대기 제한 뒤 busy 오류를 반환한다. 생성 직후 종료한 프로세스의 빈 잠금도 시간이 지나면 복구할 수 있다.

이 과정은 SSH 인증과 원격 명령 제출 이전에만 수행한다. 원격 메시지·승인·거절을 자동 재전송하지 않는다. WSL 자체가 기동할 수 없거나 SSH 서버가 준비되지 않았으면 연결 오류를 반환한다. 현재 WSL NAT 환경에서 확인했으며 다른 네트워크 구성이나 회사 Cline fork의 호환성은 별도 검증 대상이다.

이 프록시는 일반 Linux 서버 연결에는 사용하지 않는다. WSL에서는 주소 조회 프로세스가 끝난 뒤 TCP 연결만으로 배포판 실행 수명이 유지된다고 보장하지 않는다. 다른 WSL 실행 세션이 없는 환경에서는 idle 종료가 연결과 작업을 끊을 수 있다. 실제 사용 대상이 일반 Linux 서버라는 사용자 판단에 따라 WSL 수명 유지 변경은 이번 범위에서 제외했다. 일반 Linux 서버의 SSH 시간 제한과 서버 종료 정책은 별도로 적용된다.

## 검증

`tests/ssh-connection.test.mjs`는 `createClient().connect()`라는 공개 SDK 경계를 사용한다. `/bin/true`를 CLI 경로로 지정해 설치된 Cline, 인증, 기존 대화에 접근하지 않고 실제 SSH 서버의 플랫폼을 읽는다. 3개 동시 연결을 4회 반복한다.

```powershell
$env:CLINE_SDK_TEST_SSH_HOST = 'wsl'
node --test tests/ssh-connection.test.mjs
```

2026-10-11 기존 프록시에서 배너 오류로 실패한 시험이 교체 후 통과했다. 주소 캐시를 비운 추가 실행도 12건 모두 통과했다. 별도 SSH 입력 확인에서는 한글이 포함된 100,023바이트를 동시 연결 3개 모두 정확하게 전달했다. 사용자 작업을 유지하기 위해 WSL을 종료하지 않았으므로, 중지된 배포판의 cold start는 이번 검증에 포함하지 않았다.

2026-10-12 리뷰 후 빈 잠금 복구 회귀를 추가했다. 테스트 전용 TEMP/TMP에서 공개 SDK로 연결해 캐시를 만든 뒤, 캐시를 지우고 60초 된 빈 잠금으로 주소 확인 중 비정상 종료를 주입했다. 수정 전 동시 SDK 연결은 15초 뒤 busy 오류로 실패했고 수정 후 3개 모두 Linux 플랫폼을 읽었다. 이어 살아 있는 시험 프로세스의 오래된 잠금을 사용하는 보호 시험은 수정 전 잠금을 빼앗아 연결했으나, PID 생존 확인 추가 후 bounded busy 오류를 반환했다. 기존 동시 연결을 포함한 실제 SSH 시험 3개가 모두 통과했다. 사용자 캐시와 기존 대화를 수정하지 않았다.

실제 로컬 설정의 원본은 `C:\Users\kalst\.ssh\config.before-cline-sdk-proxy-20261011-235850`에 보관했다. 복구하려면 해당 백업의 기존 ProxyCommand를 되돌린다. 실행 중인 사용자 챗봇 서버와 원격 대화는 재시작하거나 중단하지 않았다.

전체 SDK·브라우저·실제 SSH 시험은 [완료 이벤트 실행 절차](test-runner-plan.md)를 따른다. 전체 결과는 완료 이벤트 수신 후 [수용 기록](chat-acceptance.md)에 반영한다.

2026-10-12 후속 전체 실행 `20261011T154136569Z-3bf33c24e64845af83dc7b840673e28f`의 완료 이벤트를 확인했다. SDK build와 SDK·실제 브라우저·실제 SSH 시험 **172/172 통과**, 실패·취소·skip 0이다. 빈 잠금 복구와 살아 있는 소유자 보호도 포함하며 완료 이벤트 이후 시험을 재실행하지 않았다.
