# grove 사용하기

<div align="center">

[English](../../USAGE.md) · [한국어](USAGE.ko.md)

</div>

grove는 git 워크트리를 관리합니다. `grove`를 실행하면 대화형 화면이 뜹니다.
워크트리마다 한 줄, 동작마다 키 하나입니다. 모든 동작은 스크립트, 에이전트,
비대화형 셸을 위한 CLI 명령(`grove add`, `grove sync`, ...)으로도 쓸 수
있습니다.

이 가이드는 화면을 먼저 다루고, 그다음 명령을 다룹니다.

- [설치와 첫 실행](#설치와-첫-실행)
- [화면](#화면)
- [자주 하는 작업](#자주-하는-작업)
- [키](#키)
- [디스크 레이아웃](#디스크-레이아웃)
- [워크트리 셋업: .grove.toml](#워크트리-셋업-grovetoml)
- [원격과 fork](#원격과-fork)
- [CLI 레퍼런스](#cli-레퍼런스)
- [스크립트와 에이전트](#스크립트와-에이전트)
- [문제 해결](#문제-해결)

## 설치와 첫 실행

```bash
brew install enginerd-kr/tap/grove   # 또는: npm install -g @enginerd-kr/grove
mkdir myapp && cd myapp
grove
```

저장소가 없는 폴더에서 `grove`는 URL을 묻고, 클론한 뒤, 화면을 엽니다. 빈
폴더는 그 자체가 저장소가 됩니다. 비어 있지 않은 폴더에는 하위 폴더에 저장소가
생깁니다.

grove는 기존 `git clone` 안에서도 동작합니다. 새 워크트리는 저장소 옆에
생깁니다(`myapp` 옆에 `myapp-feat-login`). 저장소가 여러 개인 폴더에서는
`grove`가 어느 것인지 묻습니다.

## 화면

<p align="center">
  <img src="../screens/list.svg" alt="grove 화면: 모든 워크트리, origin과 트렁크 대비 차이, 변경 여부" width="100%">
</p>

각 줄은 워크트리이고, 브랜치 이름의 폴더별로 묶입니다. `*`는 `grove`를 실행한
워크트리를 표시합니다. `▸`는 커서입니다.

| 열 | 의미 |
| --- | --- |
| remote | 브랜치가 추적하는 원격 브랜치 대비 앞선 / 뒤처진 커밋 수 |
| main | 트렁크 대비 앞선 / 뒤처진 커밋 수 |
| pr | 브랜치의 열린 풀 리퀘스트를 GitHub가 보는 대로: 번호, 체크가 통과/실패/진행 중이면 `✓` `✗` `·`, 그 뒤에 해당하는 대로 `draft`, `approved`, `changes requested`, `conflicts`. `gh`를 통해 1분마다 읽으며, `gh`가 없거나 GitHub 밖이면 이 열은 그려지지 않음 |
| state | `●` 커밋하지 않은 변경 있음, `○` 깨끗함, 그 뒤에 마지막 커밋의 시점. `merged`와 `gone`은 브랜치가 끝났다는 뜻이고, `setup stale`은 워크트리를 채운 뒤 `.grove.toml`이 바뀌었다는 뜻 |

폴더가 아니라 다른 워크트리 아래에 들여쓰기된 줄은 그 위에 올라앉은
것입니다: `grove add --on`이 거기에 쌓았습니다. 부모가 다른 폴더에 있으면
대신 state 열에 `on <branch>`라고 적힙니다.

목록 아래에는 선택한 워크트리에서 변경된 파일과, (`/log`를 켜면) 최근 커밋이
보입니다. 선택한 줄이 스택에 속해 있으면 목록 옆에 스택 전체가 보입니다:
각 브랜치가 올라앉은 브랜치 아래에, 그 브랜치 대비 얼마나 벌어졌는지와
함께 — `grove stack`이 출력하는 것과 같은 그림입니다. 하단 바는 지금 쓸 수
있는 키를 보여 줍니다.

화면은 주기적으로 새로고침됩니다. `/refresh`는 즉시 새로고침합니다.

## 자주 하는 작업

**브랜치 만들기.** `a`, 이름 입력, `enter`. grove가 브랜치와 워크트리를
만들고, `.grove.toml`을 적용하고, 에디터를 열고, `cd <path>`를 클립보드에
복사합니다. 브랜치는 선택한 워크트리에서 갈라집니다. 폴더 줄에서는 이름에
폴더 접두사가 미리 채워집니다.

**워크트리로 이동.** 선택하고 `enter`. 경로가 클립보드에 들어갑니다.

**동기화.** `s`는 fetch하고, 원격에 이어 트렁크 위로 리베이스하고, push합니다.
push가 원격 히스토리를 덮어쓰게 되면 grove가 먼저 묻습니다. 아직 어느 원격에도
없는 브랜치도 묻습니다: `y`를 누르면 push하고 추적합니다. `/sync-all`은 확인
한 번으로 모든 워크트리를 처리하고, 원격에 없는 브랜치만 알려 줍니다.

**다른 베이스 위로 리베이스.** `/rebase`는 선택한 워크트리가 올라갈 수 있는
베이스를 나열합니다: 브랜치의 원격, 쌓여 있는 부모 브랜치, 트렁크, 그리고 다른
워크트리들의 브랜치. 하나 고르고 `enter`. push는 하지 않습니다. 커밋하지 않은
변경은 잠시 치워 두었다가 리베이스 뒤에 되돌려 놓습니다. 리베이스가 충돌하거나
변경이 결과 위에 올라가지 않으면 전부 되돌립니다.

**풀 리퀘스트 열기.** `/propose`는 선택한 워크트리의 브랜치로 풀 리퀘스트를
열어 달라고 forge에 요청합니다. `--on`으로 추가한 브랜치는 자기가 올라앉은
브랜치 위로 열리므로, 스택의 두 번째 풀 리퀘스트가 첫 번째의 diff를 다시 보여
주지 않습니다. 그 밖의 브랜치는 트렁크 위로 열립니다. 프롬프트가 베이스를
보여 줍니다. `y`를 누르면 `git push`가 보낼 곳으로 브랜치를 push하고(첫 push
포함) 커밋 내용으로 채운 풀 리퀘스트를 엽니다. 이미 풀 리퀘스트가 있는
브랜치는 대신 그 사실을 알려 줍니다. `gh`가 필요합니다.

**변경 버리기.** `x`는 선택한 워크트리의 커밋하지 않은 변경을 추적되지 않는
파일까지 모두 버립니다. 버리기 전에 커밋으로 저장해 두고, `y` 뒤의 줄이
되찾는 법을 알려 줍니다: `git stash apply <sha>`.

**제거.** `r`. 프롬프트가 잃게 될 것을 나열합니다. `y`는 워크트리를 제거하고
브랜치는 남깁니다. 폴더 줄에서 `r`은 그 안의 모든 워크트리를 제거합니다.
`/prune`은 `merged` 또는 `gone` 배지가 붙은 워크트리를 한 번에 제거합니다:
프롬프트가 이름을 보여 주고, 브랜치는 남습니다.

**풀 리퀘스트 리뷰.** `/review`, 하나 고르고, `enter`. `pr/<number>`로
체크아웃됩니다. 거기서 `git push`하면 PR이 갱신되고, `s`도 마찬가지입니다.
`gh`가 필요합니다.

파괴적인 동작은 모두 먼저 묻습니다. `y`가 확인입니다. 다른 키는 취소합니다.

## 키

| 키 | 동작 |
| --- | --- |
| `↑` `↓` / `k` `j` | 이동 |
| `←` `→` / `h` `l` | 폴더 접기 또는 펼치기; 폴더 밖으로 또는 안으로 |
| `enter` | 선택한 경로 복사 |
| `a` | 선택에서 갈라진 워크트리 추가 |
| `r` | 선택 또는 폴더 전체 제거 |
| `x` | 커밋하지 않은 변경 버리기, 사본은 남김 (변경이 있을 때만 표시) |
| `s` | 선택 동기화 |
| `/` | 명령 메뉴 |
| `y` / `n` | 확인 / 취소 |
| `q` / `esc` | 종료 |

`/`는 검색 가능한 메뉴를 엽니다. 입력해서 필터하고, `↑` `↓`로 고르고,
`enter`로 실행하고, `esc`로 닫습니다.

<p align="center">
  <img src="../screens/menu.svg" alt="목록 위에 열린 / 메뉴, 입력한 내용으로 좁혀진 모습" width="100%">
</p>

| 명령 | 동작 |
| --- | --- |
| `/open` | 선택을 에디터에서 열기 |
| `/setup` | 선택에 `.grove.toml` 다시 적용 |
| `/rebase` | 선택을 고른 베이스 위로 리베이스 |
| `/propose` | 선택의 풀 리퀘스트를 올라앉은 브랜치 위로 열기 |
| `/sync-all` | 모든 워크트리 동기화 |
| `/prune` | `merged` 또는 `gone` 배지가 붙은 워크트리 제거 |
| `/review` | 열린 풀 리퀘스트 체크아웃 |
| `/upstream` | 이 저장소는 fork: 다른 저장소의 트렁크를 따르기 |
| `/refresh` | 워크트리를 지금 다시 읽기 |
| `/log` | 커밋 패널 토글 |

두 가지는 의도적으로 CLI에서만 됩니다: 커밋하지 않은 변경을 새 워크트리로
옮기기(`grove add --take`)와 브랜치를 다른 브랜치 위에 쌓인 것으로
기록하기(`grove add --on`).

## 디스크 레이아웃

```text
myapp/
  .bare/           # git 객체와 ref
  .git             # .bare를 가리키는 파일
  main/            # 기본 브랜치
  feat/login/      # 브랜치 feat/login
  feat/login-api/  # 브랜치 feat/login-api
  pr/42/           # 리뷰용으로 체크아웃한 PR
```

디렉터리 이름 = 브랜치 이름, 슬래시 포함. 각 디렉터리는 평범한 git
워크트리이고, `git`은 거기서 평소처럼 동작합니다. 루트는 절대 워크트리가
아닙니다.

## 워크트리 셋업: .grove.toml

새 워크트리에는 `.env`도 `node_modules`도 없습니다. 기본 브랜치의
`.grove.toml`이 워크트리를 어떻게 채울지 선언합니다. `a` / `grove add`를 할
때마다 적용됩니다.

```toml
[setup]
copy = [".env", "certs", "config/local.json"]
link = ["node_modules"]
env  = { PORT = 3000 }
run  = ["bun install"]
open = "code ."

[teardown]
run = ["docker compose down"]
```

| 키 | 의미 |
| --- | --- |
| `copy` | 트렁크 워크트리에서 복사. 트렁크가 우선하고, 디렉터리는 병합 |
| `link` | 트렁크의 경로로 심볼릭 링크. 이미 있는 항목은 그대로 둠 |
| `env` | `run` 명령의 환경 변수 |
| `run` | 워크트리에서 순서대로 실행하고 끝날 때까지 기다리는 명령 |
| `open` | 에디터 명령. 기다리지 않으며, 터미널이 닫혀도 살아 있음 |
| `[teardown] run` | 워크트리를 제거하기 전에 실행하는 명령 |

규칙:

- 경로는 워크트리 안에 있어야 합니다. 절대 경로, `..`, `.git`, `.bare`는
  파일 전체를 거부합니다.
- `copy`와 `link`의 경로는 패턴일 수 있습니다: `packages/*/.env`,
  `**/.env.local`, `apps/{web,api}/node_modules`. 셋업이 실행되는 시점에
  트렁크 워크트리에 대고 매칭하므로, 나중에 추가된 패키지도 포함됩니다. 보고는
  매칭된 경로 하나하나를 이름으로 적고, 아무것도 매칭되지 않은 패턴은 그 패턴
  이름 그대로 missing으로 보고됩니다.
- 알 수 없는 키는 오류입니다. `cpoy = [".env"]`는 아무 일도 안 하는 대신
  실패합니다.
- 리스트 키는 문자열 하나도 받습니다: `copy = ".env"`.

모든 키는 플랫폼별로 나눌 수 있습니다. 키는 `macos`, `linux`, `windows`이고,
테이블에서 빠진 플랫폼은 거기서 아무것도 받지 않습니다. `env`의 플랫폼 키는
그 플랫폼의 변수를 담고, 공용 변수보다 우선합니다:

```toml
[setup.open]
macos = 'open -a "Visual Studio Code" .'
linux = "code ."

[setup.copy]
macos   = [".env"]
windows = [".env", "local.bat"]

[setup.env]
PORT    = 3000
windows = { SHELL = "pwsh" }

[teardown.run]
macos = ["docker compose down", "colima stop"]
```

### 세 겹의 설정

| 파일 | 범위 |
| --- | --- |
| `~/.config/grove/config.toml` | 내 머신. `open`은 여기에 |
| `.grove.toml` | 프로젝트. 커밋됨 |
| `.grove.local.toml` | 이 체크아웃. gitignore됨 |

이 순서로 적용됩니다. 각 키는 그 키를 말한 가장 위 겹의 값을 씁니다 —
`copy`, `link`, `run`, `open`이 모두 그렇고, `env`는 변수 이름 하나씩 그렇게
됩니다. 위 겹은 키에 보태는 것이 아니라 통째로 대신하므로,
`.grove.local.toml`에 `run = []`을 쓰면 이 머신에서 프로젝트의 명령이 꺼집니다.
키를 주석 처리하는 것은 아예 쓰지 않은 것과 같아서, 아래 겹이 그대로
적용됩니다. 다른 플랫폼용으로 쓴 키는 여기서 값을 말한 것이 아닙니다.

겹이 둘 이상일 때는 각 명령이 실행되면서 어느 파일에서 왔는지 함께 말합니다.

### 신뢰

`copy`와 `link`는 즉시 실행됩니다. `run`과 `open`은 승인하기 전까지 실행되지
않습니다. 그렇지 않으면 `git pull`이 임의의 명령을 실어 올 수 있기 때문입니다.

grove는 명령을 보여 주고 묻습니다. `y`가 승인입니다. 화면에서는 `a` 다음에
나오는 프롬프트이고, CLI에서는 터미널이 붙어 있을 때 `grove add`, `grove pr`,
`grove setup`, `grove open` 아래에서 같은 질문이 나옵니다. `--trust`는 이
질문에 미리 답합니다. 파이프, `--headless`, `--json`에서는 아무것도 묻지
않습니다: 명령을 출력하고 건너뜁니다.

승인은 파일의 해시로, bare 저장소의 git config에 저장됩니다(로컬이며 절대
push되지 않음). 파일을 편집하면 승인이 취소됩니다. `config.toml`과 추적되지
않는 `.grove.local.toml`은 승인이 필요 없습니다.

### 셋업 다시 적용하기

`a`는 그 시점의 `.grove.toml`을 적용합니다. 파일이 나중에 바뀌면 옛 버전으로
채워진 줄에 `setup stale`이 붙습니다: grove는 각 워크트리가 어느 버전으로
셋업되었는지를 bare 저장소의 config에 브랜치 옆에 기록해 두고, 새로 고칠
때마다 트렁크의 파일과 비교합니다. 워크트리에서 `/setup`을 실행하거나 `grove
setup --all`을 실행해서 따라잡으세요. 멱등적입니다: `copy`는 트렁크에서
덮어쓰고, `link`는 기존 항목을 그대로 두며, `run`은 여러분의 명령입니다. 이
기록이 생기기 전에 셋업된 워크트리는 다음 셋업 전까지 배지가 붙지 않습니다.

`run`, `teardown`, `exec` 명령은 `GROVE_ROOT`, `GROVE_WORKTREE`,
`GROVE_BRANCH`를 받습니다.

## 원격과 fork

grove는 어느 원격을 쓸지 묻지 않습니다. git이 이미 아는 것을 읽으므로,
`git push`와 `git pull`이 되는 저장소는 grove에서도 같은 방식으로 됩니다.

**트렁크**는 `origin/HEAD`가 가리키는 브랜치이고, 보통 `main`입니다. 어느
복사본이 기준인지는 로컬 `main`이 추적하는 것을 따릅니다: 평범한 클론에서는
`origin/main`, fork라고 말해 둔 뒤에는 `upstream/main`. 모든 것이 그 복사본에
대고 잽니다: `main` 열, `merged` 배지, `a`가 브랜치를 자르는 베이스, `s`가
리베이스하는 대상.

**브랜치가 push되는 곳**은 `git push`가 보낼 곳입니다: 브랜치 자신의
`pushRemote`, 없으면 `remote.pushDefault`, 없으면 추적하는 원격, 없으면
`origin`. `--push`, `--publish`, 그리고 `s`가 하는 모든 push가 이 규칙을
따릅니다. `grove add`는 기존 브랜치를 같은 원격에서 찾습니다.

그래서 fork는 한 줄입니다:

```bash
grove clone git@github.com:you/repo.git --upstream git@github.com:them/repo.git
```

이미 있는 저장소라면 화면의 `/upstream`이나 `grove upstream <url>`입니다.
어느 쪽이든 git 설정 세 가지를 쓰고 grove의 것은 아무것도 쓰지 않습니다:
`upstream`이라는 원격, `git branch -u upstream/main main`, 그리고
`remote.pushDefault = origin`. `git pull`과 `git push`도 같은 세 가지를
읽습니다. 같은 URL을 다시 넣으면 아무것도 바뀌지 않고, 다른 URL은 `--force`로
바꾸라고 하지 않는 한 거부하며, 화면에서는 묻습니다.

아무것도 감지하지 않습니다. fork가 어디서 왔는지는 forge만 아는 사실이므로,
URL은 그것을 아는 사람이 한 번 입력합니다.

그 뒤로 `a`는 `upstream/main`에서 자르고, `s`는 그 위로 리베이스한 뒤 내
fork로 push하며, `merged`는 원본에 병합됐다는 뜻이 됩니다. `grove pr`은 풀
리퀘스트를 트렁크의 원격에서 가져오고, `pr/<n>` 워크트리는 `pushDefault`가
무엇이든 항상 풀 리퀘스트로 되돌려 push합니다. `doctor`는 트렁크가 아직
따르지 않는 `upstream` 원격과, 아무것도 fetch되지 않은 원격을 추적하는
트렁크를 보고합니다.

## CLI 레퍼런스

모든 명령에 `--help`가 있으며, 파서 자체의 테이블에서 생성됩니다.

```bash
grove clone <url> [-b <branch>]   # 첫 실행 화면; `init`은 별칭
grove upstream <url>              # /upstream
grove add <branch>                # a
grove list                        # 줄들을 텍스트로
grove path [target]               # enter; target 없으면 루트 출력
grove open [target]               # /open
grove setup [target | --all]      # /setup
grove sync [target | --all]       # s, /sync-all
grove rebase [target]             # /rebase
grove pr <number | url | branch>  # /review
grove propose [target]            # /propose
grove stack [target | --all]      # 쌓인 줄 옆의 패널
grove reset <target>              # x
grove remove <target>             # r
grove prune                       # /prune
grove rename <target> <name>      # 브랜치와 디렉터리를 함께 옮김
grove exec -- <command>           # 모든 워크트리에서 실행
grove doctor                      # 진단
```

`<target>`은 브랜치, 디렉터리, 또는 경로입니다. 기본값은 현재 워크트리입니다.
`-C <path>`는 저장소를 명시적으로 선택합니다.

```bash
cd "$(grove path feat/login)"
```

### add

로컬 브랜치가 있으면 그것을 쓰고, 원격 브랜치가 있으면 추적하고, 아니면 기본
브랜치에서 만듭니다.

| 플래그 | |
| --- | --- |
| `--from <base>` | 대신 `<base>`에서 만들기 |
| `--on <branch>` | `<branch>`에서 만들고 부모로 기록 (스택) |
| `--take` | 현재 워크트리의 커밋하지 않은 변경을 새 워크트리로 옮기기 |
| `--push` | push하고 upstream 설정 |
| `--trust` | `.grove.toml` 명령 승인 |
| `--no-fetch`, `--no-setup` | fetch 건너뛰기 / `.grove.toml` 건너뛰기 |

스택된 브랜치는 부모 위로 리베이스되고, 트렁크 위로는 부모를 거쳐서만
리베이스됩니다. 부모가 자식보다 먼저 동기화되고, 자식을 동기화하면 부모도
동기화됩니다. 기록은 bare 저장소 config의 `branch.<name>`이므로, `git branch
-m`이 함께 옮깁니다.

### sync

fetch한 뒤:

- **기본 브랜치**: fast-forward하거나, 로컬 커밋을 리베이스하고 push.
- **그 외 모든 브랜치**: 원격 위로 리베이스하고, 트렁크 위로 리베이스하고,
  `--force-with-lease`로 push.

변경이 있는 워크트리는 아무것도 실행하기 전에 중단합니다. 충돌한 리베이스는
`--no-abort`가 없으면 abort됩니다. `--no-push`는 결과를 로컬에 둡니다.

아직 원격에 없는 브랜치(`--push` 없이 `grove add`한 경우)는 리베이스된 뒤
종료 코드 4로 보고됩니다: 아무것도 push되지 않았고, 아무것도 거부되지
않았습니다. `--publish`는 `git push`가 보낼 곳으로 push하고 추적합니다.
`--no-push`는 로컬에 두겠다는 뜻이며, 아무것도 보고하지 않습니다. 어느
원격인지는 [원격과 fork](#원격과-fork)를 보세요.

화면은 force-push 전과 첫 push 전에 확인합니다. CLI는 둘 다 하지 않습니다.

### rebase

워크트리 하나의 브랜치를 직접 고른 베이스 위로 옮기고, push는 하지 않습니다.
`sync`는 베이스를 대신 골라 주고 push까지 합니다; 이 명령은 베이스 자체가
질문일 때를 위한 것입니다.

| 플래그 | |
| --- | --- |
| `--upstream` | 워크트리가 추적하는 브랜치 위로 |
| `--trunk` | origin이 가진 기본 브랜치 위로 (`--onto main`은 로컬 체크아웃) |
| `--onto <ref>` | 아무 브랜치나 ref 위로; origin에만 있는 이름은 `origin/<name>`으로 |
| `--no-stash` | 변경이 있는 워크트리를 옮기는 대신 거부 |
| `--no-abort` | 충돌한 리베이스나 충돌하는 변경을 그대로 둠 |
| `--no-fetch` | fetch 건너뛰기 |

베이스 플래그 셋 중 아무것도 없으면, 터미널에는 베이스 목록을 보여 주고 번호로
하나를 묻습니다. 파이프에서는 같은 목록을 stderr에 찍고 종료 코드 2로 끝납니다.

커밋하지 않은 변경은 스냅샷(커밋 하나이며, `refs/stash`는 건드리지 않음)으로
치워 두고, 리베이스한 뒤, 그 위에 다시 적용합니다. 리베이스가 충돌하거나 변경이
리베이스된 브랜치 위에 깨끗하게 적용되지 않으면 전부 되돌리고 워크트리는 정확히
원래대로 남습니다: 종료 코드 5. `--no-abort`는 대신 중간 상태를 그대로 두고
스냅샷의 sha를 출력하므로, 충돌을 해결한 뒤 `git stash apply <sha>`로 변경을
되찾을 수 있습니다.

### propose

워크트리의 브랜치로 풀 리퀘스트를 엽니다. 베이스는 `add --on`이 기록한, 그
브랜치가 올라앉은 브랜치이고, 없으면 트렁크입니다. `--base <branch>`로 달리
정할 수 있습니다. 브랜치를 먼저 `git push`가 보낼 곳으로 push합니다: 어느
원격에도 없는 브랜치는 `-u`로, 앞서 있는 브랜치는 그냥 push하고, 원격보다
뒤처진 브랜치는 `sync`로 따라잡을 때까지 거부합니다. 커밋하지 않은 변경은
경고만 하고 그대로 둡니다.

| 플래그 | |
| --- | --- |
| `--base <branch>` | `<branch>` 위로 열기 |
| `--stack` | 올라앉은 브랜치들을 아래에서부터 먼저, 그다음 이 브랜치 — 각각 바로 아래 브랜치 위로 풀 리퀘스트 하나씩 |
| `--draft` | 초안으로 열기 |
| `--title <text>` | 제목; 이것과 `--body`가 없으면 둘 다 커밋에서 채움 |
| `--body <text>` | 본문, `--title`과 함께 |
| `--web` | push한 뒤 브라우저에서 풀 리퀘스트 작성 |

이미 열린 풀 리퀘스트가 있는 브랜치는 번호와 베이스를 알려 주고 아무것도
push하지 않습니다. 그 베이스가 스택이 말하는 것과 다르면, 옮기는 `gh pr edit`
명령을 출력합니다. `gh`가 필요하며, 없으면 `10`으로 종료합니다.

`--stack`은 체인을 따라 `propose`를 실행합니다: 맨 아래 브랜치는 트렁크 위로,
그 위의 각 브랜치는 바로 아래 브랜치 위로, 대상 브랜치는 마지막에. 이미 열린
풀 리퀘스트는 알려 주고 그대로 두므로, 절반만 올렸던 스택도 마저 올라갑니다.
`--base`, `--title`, `--body`, `--web`은 각각 풀 리퀘스트 하나에 대한
것이라 함께 쓰면 거부되고, `--draft`는 전부에 적용됩니다. 대상 위에 쌓인
브랜치는 건드리지 않습니다 — 풀 리퀘스트는 작성자가 준비됐다고 할 때 여는
것이니까요.

### stack

워크트리의 브랜치가 속한 스택을 그립니다: 맨 위에 트렁크, 각 브랜치는
올라앉은 브랜치 아래에, 그 옆에 워크트리와 베이스 대비 얼마나 벌어졌는지 —
`↑`는 더한 커밋, `↓`는 뒤처진 커밋으로, `sync`가 좁힐 숫자입니다. `*`는
지금 있는 곳입니다.

```text
main
├─ feat/login *       feat/login      ↑2 ↓0
│  └─ feat/login-api  feat/login-api  ↑1 ↓1
└─ fix/crash          no worktree     ↑1 ↓0
```

스택에 있지만 워크트리가 없는 브랜치는 그렇다고 적히며, `grove add
<branch>`가 워크트리를 만들어 줍니다. 기록에는 있지만 저장소에서 사라진
브랜치는 `gone`으로 읽힙니다. `--all`은 저장소의 모든 스택을 그리고, 쌓이지
않은 브랜치는 트렁크 아래 혼자 그려집니다. git만 읽습니다 — 브랜치에 풀
리퀘스트가 있는지는 forge의 몫이고, 화면의 `pr` 열이 그것을 보여 줍니다.

### remove / prune

`remove`는 `--force`가 없으면 안전하지 않은 워크트리를 거부합니다. 리베이스
중인 워크트리는 무조건 거부합니다. `--delete-branch`는 브랜치를 삭제합니다.
`--no-teardown`은 `[teardown]`을 건너뜁니다.

`prune`은 fetch한 뒤, 브랜치가 원격에서 사라졌거나(`--gone`) 트렁크에
병합된(`--merged`) 워크트리를 제거합니다. 플래그가 없으면 둘 다입니다. `-n`은
제거될 것을 출력만 합니다. 변경이 있거나, 리베이스 중이거나, 잠겼거나, 현재인
워크트리는 건너뛰고 보고합니다.

`--closed`는 forge만 볼 수 있는 한 가지 경우를 더합니다: 병합 없이 닫힌 풀
리퀘스트로, 브랜치는 원격에 그대로 있고 커밋은 트렁크에 하나도 없는 경우입니다.
앞의 두 답이 남겨 둔 워크트리마다 `gh`에 하나씩 묻고, 풀 리퀘스트의 head가
워크트리가 서 있는 커밋과 같을 때만 셉니다. 그래서 재사용된 브랜치 이름이 옛
풀 리퀘스트에 걸리지 않습니다. `gh`가 필요하며, 없으면 아무것도 제거하기 전에
`10`으로 종료합니다. 화면의 `/prune`은 forge에 묻지 않습니다.

### reset

`git reset --hard`. `--clean`은 추적되지 않는 파일도 삭제합니다. `--to <ref>`는
다른 ref로 리셋합니다.

버리는 것은 먼저 저장합니다. 어떤 ref도 건드리지 않는 커밋 하나로, `git stash
push -u`가 저장하는 것과 같은 모양입니다: 추적 중인 변경과 (`--clean`이면)
추적되지 않는 파일까지. sha를 출력하므로 `git stash apply <sha>`로 전부
되찾을 수 있습니다. 브랜치마다 가장 최근 스냅샷은 `refs/grove/discarded/<branch>`
아래에도 붙잡아 두므로 git의 정리 작업을 견디고, 그 전 것은 git이 참조 없는
객체를 지울 때까지 sha로 닿을 수 있습니다. 화면의 `x`는 `reset --clean`이고,
`y` 뒤에 같은 줄을 보여 줍니다.

### exec

`--` 뒤의 명령을 모든 워크트리에서 셸 한 줄이 아니라 프로세스로 실행합니다.
셸 문법에는 `sh -c`를 쓰세요. `--fail-fast`가 없으면 실패해도 계속합니다.
명령의 stdout만 stdout으로 갑니다.

```bash
grove exec -- bun install
grove exec -- git status --short
grove exec -- sh -c 'echo $GROVE_BRANCH'
```

## 스크립트와 에이전트

- `--json`은 JSON 문서 하나를 stdout에 출력합니다. 사람용 출력은 stderr로
  갑니다.
- `--headless`(또는 TTY가 아닌 경우)는 화면을 끕니다. 명령은 절대 묻지
  않습니다. 실행하거나 종료 코드로 실패합니다.
- `--verbose`는 모든 git 명령을 종료 코드와 소요 시간과 함께 기록합니다.

| 종료 코드 | 의미 |
| --- | --- |
| 0 | 정상 |
| 1 | grove 버그 |
| 2 | 사용법 오류 |
| 3 | 저장소가 아님 |
| 4 | 거부됨 |
| 5 | 리베이스 충돌 |
| 6 | 상태 충돌 (`doctor`가 문제를 찾은 경우도 포함) |
| 7 | git 명령 실패 |
| 8 | 원격 오류 |
| 9 | `[setup]` 명령 실패 (워크트리는 존재함) |
| 10 | `gh`가 없거나 실패 |
| 11 | 하나 이상의 워크트리에서 `exec` 실패 |
| 130 | Ctrl-C |

### `--json`이 말하는 것

모든 명령의 문서는 그 명령의 결과 객체이며, 스크립트에서 읽을 필드는 아래
것들뿐입니다. 판정은 종료 코드입니다: 0이 아니면 실패이고, stderr에 찍힌
내용으로 성공을 추측해서는 안 됩니다.

| 명령 | 읽을 만한 필드 |
| --- | --- |
| `add` | `path`, `dir`, `branch`, `source` (`existing`/`remote`/`new`), `alreadyPresent`, `setup` |
| `add`의 `setup` | `copied`, `linked`, `ran`, `missing`, `untrusted`, `failed` |
| `list` | 워크트리마다 한 줄: `dir`, `branch`, `dirty`, `ahead`, `behind`, `finished`, `setupStale` |
| `propose` | `url`, `number`, `base`, `created` (이미 있었으면 false), `pushed`; `--stack`이면 이것들의 배열, 아래에서 위로 |
| `stack` | `trunk`, 그리고 위에서 아래로 `rows[]`, 각각 `branch`, `parent`, `depth`, `dir` (워크트리가 없으면 없음), 부모 대비 `ahead`/`behind`, `exists`, `current` |
| `reset` | `saved`: 스냅샷의 sha, `git stash apply`용 |
| `sync` | 아무것도 push하지 않고 종료 코드 `4`이면 브랜치가 아직 어느 원격에도 없다는 뜻 |
| `prune -n` | `entries[]`, 각각 `dir`, `reason`, 그리고 남는 경우 `skipped` |

`setup.untrusted: true`는 `.grove.toml`의 명령이 출력만 되고 실행되지
않았다는 뜻입니다. 이 머신에서 아무도 그 버전의 파일을 승인하지 않았기
때문입니다. `setup.failed`는 명령이 0이 아닌 코드로 끝났을 때 설정되며,
워크트리는 어느 쪽이든 존재하고 `add`는 `9`로 종료합니다.

### 신뢰는 사람의 결정입니다

이 게이트는 사람이 `.grove.toml`의 명령을 읽은 뒤에 실행되게 하려고
있습니다. 에이전트가 `--trust`를 넘기는 것은 바로 이 게이트가 막으려는
행동입니다. 파일은 본인이 한 번 승인하세요: 화면이 물을 때 `y`, 또는
터미널에서 `grove setup --trust`. 승인은 저장소에 저장되므로, 그 뒤로 이
머신에서 하는 모든 `grove add`는 에이전트든 아니든 묻지 않고 명령을
실행합니다.

파일이 승인된 뒤의 전형적인 에이전트 루프:

```bash
grove add agents/<task> --json           # 생성; stdout에서 `path` 읽기
# ... 워크트리에서 작업 ...
grove sync agents/<task> --publish        # 첫 push까지; 없으면 종료 코드 4
grove remove agents/<task> --delete-branch
```

`AGENTS.md`나 `CLAUDE.md`에 그대로 붙여 넣을 수 있는 정책:

```markdown
## Worktrees

- `grove list --json`으로 확인한다. 브랜치 이름에서 경로를 추측하지 않는다.
- 작업마다 `grove add agents/<task> --json`으로 워크트리를 만들고, 반환된
  `path` 안에서만 작업한다.
- 0이 아닌 종료 코드는 실패다. 로그에서 성공을 읽어내지 않는다.
- 결과에 `setup.untrusted`가 있으면 보고한다. `--trust`는 절대 넘기지
  않는다. 셋업 파일의 승인은 사용자의 결정이다.
- 사용자가 그 정리를 요청하지 않았다면 `grove remove`, `grove prune`,
  `--delete-branch`, `--force`, `grove reset`을 실행하지 않는다.
```

## 문제 해결

```bash
grove doctor
```

문제와 각각을 고치는 명령을 보고합니다. 아무것도 쓰지 않습니다. 검사 항목:
fetch refspec이 없는 bare 클론, 아무것도 fetch되지 않은 원격을 추적하는
트렁크, 트렁크가 따르지 않는 `upstream` 원격, git은 나열하지만 디스크에 없는
워크트리, 남은 디렉터리, 잘못된 곳을 가리키는 루트 `.git`, 깨진 심볼릭 링크.
문제가 있으면 `6`, 경고만 있으면 `0`으로 종료합니다.

디스크에 없는 경우 중 하나는 git 자신에게도 보이지 않습니다: 잠긴 채 삭제된
워크트리입니다. 코딩 에이전트가 작업 중인 워크트리를 잠그고, 세션이 죽고,
디렉터리는 정리되는데, `git worktree prune`은 설계상 잠긴 항목을 건너뛰기
때문에 항목이 남습니다. 그러면 브랜치는 존재하지 않는 경로에 체크아웃된 것으로
읽히고, 그 브랜치의 `grove add`는 실패합니다. `doctor`는 그 항목을 이름으로
짚고, prune 전에 실행할 unlock을 출력합니다.

버그가 아닌 것:

- **아무것도 설치되지 않았어요.** `run`은 신뢰가 필요합니다: 물어볼 때 `y`로
  답하거나 `--trust`를 넘기세요. 파이프에서는 묻지 않습니다. `copy` / `link`는
  내 브랜치가 아니라 트렁크 워크트리에서 읽습니다.
- **`grove`가 화면 대신 사용법을 출력했어요.** TTY가 없거나 `--headless`입니다.
- **`grove exec`가 내 플래그를 먹었어요.** 명령 앞에 `--`를 넣으세요.
- **`grove <command>`가 저장소 선택을 거부했어요.** 폴더에 저장소가 여러 개
  있습니다. 하나로 `cd`하거나 `-C`를 넘기세요.

## grove가 아닌 것

- git의 대체품이 아닙니다. 모든 워크트리는 평범한 git 워크트리입니다.
- 패키지 관리자가 아닙니다. 셋업 명령은 여러분의 것입니다.
- 비밀 관리자가 아닙니다. `.grove.toml`은 커밋됩니다. 비밀은 로컬 겹에
  두세요.
