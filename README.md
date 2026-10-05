# 문서 에이전트 (데스크톱 앱)

문서를 읽고, 요약하고, 새 문서를 만드는 Claude 기반 데스크톱 앱입니다. Windows용 실행 파일(exe 하나)로 배포하고, 크롬북(Linux)에서 개발·테스트할 수 있습니다.

- 대화하면서 작업 폴더 안의 문서를 다룹니다. 파일을 끌어다 놓으면 작업 폴더의 `첨부` 폴더로 복사됩니다.
- 파일을 만들거나 바꾸기 전에 미리보기를 보여주고 허용/거부를 묻습니다. 거부할 때 이유를 적으면 에이전트가 반영해 다시 시도합니다.
- 삭제는 작업 폴더의 `.agent-trash/` 로 옮기는 방식이라 복구할 수 있습니다.

## 지원 형식

| 형식 | 읽기 | 만들기 | 서식 유지 글자 바꾸기 |
| --- | --- | --- | --- |
| 한글 .hwpx | O | O (표·굵게 미지원, 표는 탭 구분 줄) | O |
| 한글 .hwp | O (글자만, 배포용·암호 문서 제외) | X | X |
| 워드 .docx | O | O | O |
| 워드 .doc | O (글자만) | X | X |
| 엑셀 .xlsx / .csv | O | O (.xlsx, 마크다운 표가 시트가 됨) | X |
| 파워포인트 .pptx | O (글자만) | X | O |
| PDF | O (Claude가 원본을 직접 봄, 30MB 이하) | O | X |
| 이미지 png/jpg/gif/webp | O (5MB 이하) | X | X |
| ODF .odt/.ods/.odp, 텍스트 파일 | O | .md/.txt/.html | X |

구형 .xls/.ppt 는 원본 프로그램에서 .xlsx/.pptx 로 저장한 뒤 쓰세요.

기관 양식(.hwpx/.docx)을 받으면 작업 폴더에 넣고 "이 양식으로 ○○ 공문 만들어줘"라고 요청하세요. 양식을 복사해 빈칸만 채우므로 서식이 그대로 유지됩니다.

## 크롬북에서 실행 (테스트용)

1. 설정 → 고급 → 개발자 → "Linux 개발 환경"을 켭니다. "터미널" 앱이 생깁니다.
2. 터미널에서 처음 한 번만 실행합니다.
   ```
   sudo apt update
   sudo apt install -y git curl fonts-noto-cjk libnss3 libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 libxss1
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs
   git clone -b claude/local-mindmap-tool-r3jfc7 https://github.com/ocean1231-nub/register.git
   cd register/desktop
   npm install
   ```
3. 실행
   ```
   cd ~/register/desktop
   npm start
   ```
   "SUID sandbox helper" 오류로 창이 안 뜨면 `npm run start:nosandbox` 로 실행하세요 (테스트용).
4. 처음 실행하면 API 키를 묻습니다. https://platform.claude.com/settings/keys 에서 발급받아 붙여 넣으세요 (결제 수단 등록 또는 크레딧 충전 필요).
5. "작업 폴더 선택"으로 문서가 있는 폴더를 고릅니다. 크롬북의 "내 파일" 폴더는 파일 앱에서 오른쪽 클릭 → "Linux와 공유"를 해야 보입니다 (`/mnt/chromeos/MyFiles/...`).

한글 입력이 안 되면 다른 앱에서 쓴 뒤 붙여 넣으세요. 크롬북의 Linux 앱 한글 입력 지원은 ChromeOS 버전에 따라 다릅니다.

## Windows에서 받기

https://github.com/ocean1231-nub/register/releases/download/desktop-latest/DocumentAgent.exe

링크를 누르면 `DocumentAgent.exe` 하나가 받아집니다. 설치 없이 더블클릭하면 실행됩니다 (로그인 불필요, 링크 고정).

- 코드 서명을 하지 않은 파일이라 처음 실행할 때 "Windows의 PC 보호" 창이 뜹니다. "추가 정보" → "실행"을 누르세요.
- 실행할 때마다 내부 파일을 푸느라 창이 뜨기까지 몇 초 걸립니다.
- `desktop/` 변경을 GitHub에 올리면 GitHub Actions의 "Desktop app build"가 Windows에서 테스트·빌드한 뒤 같은 링크의 파일을 새 버전으로 바꿉니다.

Windows PC에서 직접 만들려면: Node.js 22 설치 후 `npm install` → `npm run dist:win` (결과물은 `dist/DocumentAgent.exe`).

## 대화 중

- 위쪽 모델 선택: Opus 5.5(기본, 가장 정확) / Sonnet 5.5(약 절반 가격) / Haiku 4.5(가장 저렴)
- 설정의 "생각 깊이": 높을수록 정확하지만 느리고 비쌉니다. 기본 "보통".
- 오른쪽 위 금액: 이번 실행에서 쓴 예상 비용 (토큰 수로 계산한 추정치. 정확한 청구액은 https://platform.claude.com).
- 작업 중 "중단" 버튼으로 멈출 수 있습니다. "새 대화"는 대화 기록을 지웁니다.

## 저장 위치

- 설정과 API 키: Windows `%APPDATA%\문서 에이전트\settings.json`, Linux `~/.config/문서 에이전트/settings.json`. 키는 운영체제 암호화 기능(safeStorage)으로 암호화해서 저장합니다. 암호화 기능이 없는 일부 Linux 환경에서는 이 파일에 평문으로 저장됩니다.
- 대화 기록은 저장하지 않습니다. 앱을 닫으면 사라집니다.

## 개발

```
npm test          # 문서 변환, 도구, 에이전트 루프 테스트 (API 키 불필요)
npm run test:ui   # 화면 테스트 (playwright 필요)
```

`HWP_SAMPLE_DIR=폴더 npm test` 로 .hwp 샘플 폴더를 지정하면 HWP 읽기도 검사합니다.

구조: `main.js`(창, 설정, IPC) · `preload.js`(화면에 노출하는 API) · `src/agent.js`(Claude API 루프) · `src/tools.js`(작업 폴더 도구) · `src/documents.js`(문서 변환) · `renderer/`(화면)

`src/assets/Skeleton.hwpx` 는 python-hwpx(Apache-2.0)의 빈 문서 양식입니다. `src/assets/NOTICE.txt` 참고.
