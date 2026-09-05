# grove 사용 설명서

[English](../../USAGE.md) · [한국어](USAGE.ko.md) · [프로젝트 소개](README.ko.md)

grove는 브랜치마다 작업 폴더를 만들어 개발과 PR 리뷰를 동시에 진행하게 해 줍니다.
처음에는 아래의 **기본 개발 흐름**만 따라 하세요. 프로젝트 셋업은 한 번 정해
두면 새 워크트리를 만들 때 적용됩니다. 추가 옵션은 필요한 상황에서 찾아 쓰면 됩니다.

- [기본 개발 흐름](#기본-개발-흐름)
- [동기화는 무엇을 하나요?](#동기화는-무엇을-하나요)
- [대화형 화면](#대화형-화면)
- [프로젝트 셋업](#프로젝트-셋업)
- [필요할 때 쓰는 옵션](#필요할-때-쓰는-옵션)
- [문제 해결](#문제-해결)
- [명령어 찾아보기](#명령어-찾아보기)
- [스크립트와 에이전트](#스크립트와-에이전트)

## 기본 개발 흐름

### 1. 설치하고 클론하기

Git이 설치된 환경에서 grove를 설치합니다. 아래 설치 방법 중 하나를 선택하세요.

```bash
brew install enginerd-kr/tap/grove
# 또는 npm으로 설치 (macOS, Linux; Node 18+)
npm install -g @enginerd-kr/grove
```

사용할 저장소의 URL로 바꿔 실행하세요.

```bash
grove clone https://github.com/org/repo.git
cd repo
```

기본 브랜치 워크트리를 만들고 프로젝트 셋업을 적용합니다. 실행할 셋업 명령이
처음 나타나면 내용을 확인하고 `y`로 승인하세요. 나중에 준비하려면 이 단계에서
승인하지 않고 `grove setup main`으로 다시 실행할 수 있습니다.

이 설명서는 기본 브랜치가 `main`인 저장소를 예로 듭니다. `master` 등 다른
이름을 쓰는 저장소에서는 `main`을 실제 이름으로 바꾸세요. 문서와 명령 옵션의
`trunk`는 이 기본 브랜치를 뜻합니다.

```text
repo/             # 워크스페이스: 여러 작업을 관리하는 위치
  .bare/          # 공통 Git 저장소
  .git            # .bare를 가리키는 파일
  main/           # 기본 브랜치 워크트리
```

`repo/`는 관리용 폴더입니다. 코드를 수정하거나 Git으로 커밋할 때는 그 안의
워크트리로 이동하세요. 아래에서 별도 안내가 없는 명령은 `repo/`에서 실행합니다.

### 2. 새 작업 시작하기

```bash
grove add feat/login
cd feat/login
```

`repo/feat/login/`에 작업 폴더를 만들고 셋업을 적용합니다. 새 브랜치는 fetch한
최신 원격 기본 브랜치에서 시작합니다. 로컬 `main`에서 커밋하거나 먼저
`grove sync main`을 실행할 필요는 없습니다.

이미 있는 브랜치 이름을 입력하면 그 브랜치를 체크아웃합니다. 워크트리까지
이미 있으면 기존 경로를 알려 줍니다.

코드 수정, 테스트, 커밋은 이 폴더에서 평소처럼 진행하세요. 다른 작업을 시작해도
이 워크트리의 변경은 남아 있습니다.

### 3. 작업한 내용을 PR로 올리기

변경을 커밋한 뒤, `feat/login/` 안에서 실행합니다.

```bash
grove propose
```

브랜치를 push하고 커밋 내용을 바탕으로 PR을 엽니다. 처음 올리는 브랜치도
push하므로 별도의 첫 push 명령은 필요 없습니다. 직접 제목과 본문을 작성하려면
`grove propose --web`을 사용하세요. PR 관련 기능에는 GitHub CLI인 `gh` 설치와
로그인이 필요합니다. 로그인은 `gh auth login`으로 합니다.

PR을 올린 뒤 원격 변경과 기본 브랜치의 변경을 반영할 때는, 변경을 커밋해
워크트리가 깨끗한 상태에서 실행하세요.

```bash
grove sync
```

개발 브랜치의 `sync`는 rebase 후 원격 브랜치가 있으면 push합니다. 충돌이나 첫 push를 다루는 방법은
[동기화 설명](#동기화는-무엇을-하나요)을 보세요.

### 4. 다른 사람의 PR 리뷰하기

워크스페이스로 돌아와 리뷰할 PR 번호를 입력합니다.

```bash
cd "$(grove path)"
grove pr 42
cd pr/42
```

`pr/42/`에서 코드를 읽거나 테스트하세요. 개발 중이던 `feat/login/`은 그대로
남습니다. 작성자가 새 커밋을 올리면 리뷰 폴더에서 다음을 실행합니다.

```bash
grove sync
```

**PR 리뷰 워크트리에서는 PR의 최신 커밋만 받아옵니다.** rebase나 push를 하지
않습니다. 로컬 커밋과 변경 때문에 갱신할 수 없으면 중단하고 이유를 알려 줍니다.
PR이 force-push된 경우는 [리뷰 워크트리 교체](#pr이-force-push되어-업데이트가-막혔을-때)를 보세요.

### 5. 끝난 작업 정리하기

워크스페이스로 돌아와 정리할 대상을 먼저 확인합니다.

```bash
cd "$(grove path)"
grove prune -n
```

후보 목록을 확인한 뒤 실제로 제거합니다.

```bash
grove prune
```

기본적으로 원격에서 사라졌거나 병합된 브랜치의 워크트리를 정리하고, 로컬
브랜치는 남깁니다. squash merge한 PR이 후보에 안 보이면
[GitHub 병합 상태로 정리](#squash-merge한-작업이-정리-후보에-없을-때)를 사용하세요.

리뷰 폴더처럼 특정 워크트리 하나만 지우려면 `grove remove pr/42`를 실행합니다.
변경이 있는 워크트리는 기본적으로 제거를 거부합니다. 셋업에 정리 명령이 있으면
디렉터리를 지우기 전에 실행합니다.

## 동기화는 무엇을 하나요?

`sync`는 대상 브랜치의 용도에 따라 동작합니다. 워크트리 안에서는 `grove sync`,
워크스페이스에서는 `grove sync feat/login`처럼 대상을 지정하세요.

| 대상 | 예시 | 동작 |
| --- | --- | --- |
| 개발 브랜치 | `grove sync feat/login` | fetch → 추적하는 원격 브랜치와 기본 브랜치 위로 rebase → push |
| PR 리뷰 워크트리 | `grove sync pr/42` | PR의 최신 커밋으로 업데이트 |
| 기본 브랜치 | `grove sync main` | 원격 변경을 fast-forward로 반영 |

CLI의 개발 브랜치 동기화는 필요하면 `--force-with-lease`로 push하며, 별도
확인을 묻지 않습니다. 대화형 화면에서는 히스토리를 덮어쓰는 push 전에
확인합니다. 원격 브랜치가 없으면 로컬에서 동기화합니다.

| 필요한 동작 | 명령 |
| --- | --- |
| 아직 PR을 열지 않고 브랜치부터 처음 push하기 | `grove sync feat/login --publish` |
| 동기화한 결과를 로컬에만 두기 | `grove sync feat/login --no-push` |
| 모든 워크트리 동기화하기 | `grove sync --all` |

원격 브랜치가 없는 개발 브랜치는 기본 브랜치 위로 rebase하고 push 없이
정상 완료합니다. 추적하던 원격 브랜치가 삭제된 경우도 같습니다. 스택 브랜치는
기존처럼 부모 브랜치를 기준으로 동기화합니다. 처음 올릴 때는 `propose`나
`sync --publish`를 사용하세요.

커밋하지 않은 변경이 있으면 동기화를 거부합니다. rebase 충돌은 기본적으로
abort하며, 오류에 표시된 상태와 안내를 확인하세요. 기본 브랜치의 로컬 커밋과
원격이 갈라졌을 때는 자동 rebase하지 않고 중단합니다.

## 대화형 화면

명령을 입력하는 대신, 워크스페이스나 워크트리 안에서 `grove`를 실행해도 됩니다.
각 줄이 워크트리 하나입니다. `*`는 현재 워크트리, `▸`는 선택한 줄입니다.

<p align="center">
  <img src="../screens/list.svg" alt="워크트리 목록과 원격 대비 차이, 변경 상태를 보여 주는 grove 화면" width="100%">
</p>

먼저 다음 키로 시작하세요.

| 키 | 동작 |
| --- | --- |
| `↑` `↓` / `k` `j` | 워크트리 선택 |
| `a` | 최신 원격 기본 브랜치에서 새 작업 만들기 |
| `enter` | 선택한 워크트리 경로 복사 |
| `s` | 선택한 워크트리 동기화 |
| `/` | 명령 메뉴 열기 |
| `q` / `esc` | 종료 |

`a`를 누르고 브랜치 이름을 입력하면 셋업을 적용하고, 설정된 에디터를 엽니다.
`cd <path>`도 클립보드에 복사하므로 터미널에 붙여 넣어 이동할 수 있습니다.
`enter`로 경로만 복사한 경우에는 `cd` 뒤에 붙여 넣으세요. grove가 실행 중인
셸의 디렉터리를 직접 바꾸지는 않습니다.

`/` 메뉴는 입력해서 검색하고 `enter`로 실행합니다.

| 메뉴 | 할 일 |
| --- | --- |
| `/propose` | 선택한 개발 브랜치로 PR 열기 |
| `/review` | 열린 PR을 골라 리뷰 워크트리 만들기 |
| `/open` | 선택한 워크트리를 에디터에서 열기 |
| `/setup` | 선택한 워크트리 셋업 다시 실행 |
| `/prune` | `merged` 또는 `gone`인 워크트리 정리 |
| `/sync-all` | 모든 워크트리 동기화 |
| `/rebase` | 선택한 워크트리를 다른 베이스 위로 rebase |
| `/upstream` | fork의 원본 저장소 지정 |
| `/refresh` | 목록 즉시 새로고침 |
| `/log` | 최근 커밋 패널 켜기·끄기 |

추가 키: `A`는 선택한 로컬 브랜치에서 분기하고, `r`은 선택한 워크트리를
제거합니다. `x`는 커밋하지 않은 변경을 미추적 파일까지 버리되 복구용 사본을
남깁니다. 화면의 제거·변경 버리기는 `y`로 확인합니다. 폴더 줄에서 `r`을 누르면
그 폴더 안의 워크트리가 모두 대상이 됩니다. `←` `→` / `h` `l`로 폴더를 접거나
펼칠 수 있습니다.

### 목록 읽기

| 열·표시 | 의미 |
| --- | --- |
| `remote` | 추적하는 원격 브랜치 대비 앞선·뒤처진 커밋 수 |
| `main` | 기본 브랜치의 원격 기준 대비 앞선·뒤처진 커밋 수 |
| `pr` | PR 번호, 체크 결과, 리뷰 상태. GitHub와 `gh`를 사용할 때 표시 |
| `●` / `○` | 커밋하지 않은 변경 있음 / 깨끗함 |
| `merged` / `gone` | 병합됨 / 추적하던 원격 브랜치가 사라짐 |
| `setup pending`, `setup failed`, `setup stale` | [셋업 확인 또는 재실행이 필요함](#셋업-상태와-재실행) |
| `review #42 → main` | 리뷰 중인 PR과 그 PR의 실제 병합 대상. 뒤의 숫자는 해당 대상과의 커밋 차이 |
| `on <branch>` 또는 다른 워크트리 아래 들여쓰기 | 다른 개발 브랜치 위에 쌓은 작업 |

목록 아래에는 선택한 워크트리의 변경 파일이 보입니다. 스택에 속한 작업을
선택하면 브랜치 사이의 관계도 표시됩니다.

목록은 자동으로 새로고침됩니다. 원격과 PR 정보는 따로 갱신하므로 네트워크가
느려도 로컬 변경을 확인할 수 있습니다. 헤더에는 마지막 백그라운드 fetch와
실패 여부가 표시됩니다. `/refresh`는 로컬 워크트리를 즉시 다시 읽습니다.

## 프로젝트 셋업

이미 `.grove.toml`이 있는 프로젝트를 사용한다면 실행할 명령을 확인하고
승인하면 됩니다. 프로젝트의 준비 과정을 자동화하려는 사람이 이 절의 설정을
작성합니다.

### 최소 설정부터 시작하기

기본 브랜치 워크트리의 `main/.grove.toml`에 다음을 작성하세요. 예시는 Bun
프로젝트이며, `run`에는 `pnpm install`, `uv sync` 등 프로젝트에 맞는 명령을 씁니다.

```toml
[setup]
run = ["bun install"]
```

워크스페이스에서 직접 적용해 볼 수 있습니다.

```bash
grove setup main
```

프로젝트에서 함께 쓰도록 `.grove.toml`을 Git으로 커밋하고 기본 브랜치에
반영하세요. 이후 `clone`, `add`, `pr`로 만드는 워크트리에 적용됩니다.

`.env` 복사도 필요하다면 다음처럼 추가합니다.

```toml
[setup]
copy = [".env"]
run = ["bun install"]
```

복사할 실제 파일은 로컬 `main/.env`에 준비하고 `.gitignore`에 넣습니다.
`.grove.toml`에는 비밀 값을 넣지 마세요. `copy`는 로컬 기본 브랜치 워크트리에서
읽으므로 clone만으로 다른 사람의 `.env`가 생기지는 않습니다.

의존성은 워크트리별로 설치하세요. 브랜치마다 lockfile이 다를 수 있으므로
`node_modules`를 공유하는 대신 패키지 관리자의 다운로드 캐시를 활용합니다.

### 실행 승인

처음 보는 프로젝트 명령은 내용을 보여 주고 승인을 받습니다. 터미널이나
대화형 화면에서 `y`를 누르면 이 저장소에 승인이 저장되고, 같은 내용은 다음부터
묻지 않습니다. 프로젝트 설정이 바뀌어 아직 승인하지 않은 내용이 되면 다시
확인합니다. `copy`와 `link`는 명령 승인 전에도 적용됩니다.

셋업을 미뤘다면 `grove setup feat/login`으로 다시 실행하세요.
`--trust`는 명령 내용을 이미 확인했을 때 승인 질문을 생략하는 옵션입니다.
파이프, `--json`, `--headless`에서는 질문하지 않고 미승인 명령을 건너뜁니다.

### 셋업 상태와 재실행

설치 실패 때문에 워크트리를 다시 만들 필요는 없습니다. 출력에서 실패한
명령의 원인을 해결한 뒤 기존 워크트리에 셋업을 다시 적용하세요.

```bash
grove setup feat/login
# 모든 워크트리를 다시 준비해야 할 때
grove setup --all
```

| 상태 | 의미와 할 일 |
| --- | --- |
| `pending` | 셋업 생략, 미승인 명령 또는 복사 원본 누락. 안내를 확인하고 `grove setup <branch>` 실행 |
| `running` | 셋업 진행 중 |
| `failed` | 셋업 실패. 오류 원인을 해결하고 다시 실행 |
| `ready` | 셋업 완료. 목록에는 별도 배지를 붙이지 않음 |
| `stale` | 완료 이후 설정이나 감지 대상 의존성 파일이 바뀜. 셋업 다시 실행 |

변경 감지에는 적용한 설정 파일과 대상 워크트리 루트의 `package.json`,
`bun.lock`, `bun.lockb`, `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`,
`uv.lock`, `pyproject.toml`, `Cargo.lock`, `go.sum`을 사용합니다.
`ready`는 셋업 실행이 끝났다는 뜻이며, 앱의 테스트나 실행 결과를 보장하지는
않습니다. 복사할 파일을 찾지 못하면 `missing`을 안내하고 `pending`으로 남습니다.

다시 실행하면 `copy`는 기존 파일을 기본 브랜치의 값으로 덮어쓰고, `run`은
처음부터 실행합니다. 워크트리마다 다른 값을 유지할 파일은 복사 대상과
분리하고, 설치 스크립트는 반복 실행할 수 있게 작성하세요. `setup`은 에디터를
다시 열지 않습니다. 에디터는 `grove open feat/login`으로 엽니다.

### 추가 설정 찾아보기

| 항목 | 용도 |
| --- | --- |
| `[setup] copy` | 기본 브랜치의 파일·디렉터리를 복사. 디렉터리는 병합하며 같은 파일은 덮어씀 |
| `[setup] link` | 기본 브랜치의 경로에 심볼릭 링크. 대상에 이미 있는 항목은 유지 |
| `[setup] env` | 셋업 명령에 전달할 환경 변수 |
| `[setup] run` | 새 워크트리에서 순서대로 실행하고 기다리는 셸 명령 |
| `[setup] open` | 에디터 실행 명령. 종료를 기다리지 않음 |
| `[teardown] run` | 워크트리 제거 전에 실행할 정리 명령 |
| `[teardown] env` | 정리 명령에 전달할 환경 변수 |

`copy`와 `link`에는 `packages/*/.env`, `**/.env.local` 같은 패턴도 쓸 수
있습니다. 기본 브랜치 워크트리에서 일치하는 경로를 찾습니다. 경로는 워크트리
내부의 상대 경로여야 하고, 절대 경로나 `..`, `.git`, `.bare`는 사용할 수
없습니다. 알 수 없는 설정 키는 오류로 알려 줍니다.

### 개인 설정과 에디터

| 우선순위 | 파일 | 용도 |
| --- | --- | --- |
| 1 — 기본값 | `~/.config/grove/config.toml` | 모든 프로젝트에서 사용할 내 설정 |
| 2 | `.grove.toml` | 프로젝트 공통 설정 |
| 3 — 우선 적용 | `.grove.local.toml` | 해당 프로젝트에서 쓸 내 로컬 설정 |

기본적으로 프로젝트 파일 두 개는 모두 `main/`에서 읽습니다.
`--config-source worktree`를 선택한 브랜치는 자기 워크트리에서 읽습니다.
`.grove.local.toml`은 `.gitignore`에 추가하세요.

같은 키가 여러 파일에 있으면 우선순위가 높은 파일의 값을 사용합니다.
`run`, `copy`, `link` 목록은 합치지 않고 교체하며, `env`는 변수별로 덮어씁니다.
예를 들어 `.grove.local.toml`의 `[setup]`에 `run = []`을 쓰면 프로젝트의
셋업 명령을 끕니다. 전역 설정과 Git에서 추적하지 않는 로컬 설정은 별도
승인 없이 적용됩니다.

개인 에디터는 `~/.config/grove/config.toml`에 설정할 수 있습니다.

```toml
[setup]
open = "code ."
```

플랫폼별 설정이 필요하면 `macos`, `linux`, `windows`를 사용합니다.

```toml
[setup.open]
macos = 'open -a "Visual Studio Code" .'
linux = "code ."

[setup.env]
API_HOST = "http://localhost:3000"
windows = { SHELL = "pwsh" }
```

`copy`, `link`, `run`, `[teardown] run`도 플랫폼별 목록으로 나눌 수 있습니다.
플랫폼을 생략한 값은 공통으로 적용하고, 플랫폼 표에서 빠진 운영체제에는
그 표의 설정을 적용하지 않습니다.

## 필요할 때 쓰는 옵션

### 작업을 시작한 뒤 새 브랜치로 옮기고 싶을 때

변경이 있는 워크트리 안에서 실행하세요.

```bash
grove add feat/search --take
```

커밋하지 않은 변경을 새 워크트리로 옮기고, 원래 워크트리는 깨끗하게 남깁니다.
커밋한 변경을 기준으로 새 브랜치를 만들려면 아래의 `--from`을 사용하세요.

### 다른 개발 브랜치에서 이어서 작업할 때

```bash
grove add feat/login-ui --from feat/login
```

시작점만 고릅니다. 대화형 화면에서는 `feat/login`을 선택하고 `A`를 누릅니다.
두 작업의 의존 관계도 기억해야 한다면 `--on`을 사용하세요.

```bash
grove add feat/login-ui --on feat/login
grove stack feat/login-ui
grove propose feat/login-ui --stack
```

`--on`으로 만든 브랜치는 부모 위로 동기화되며, PR의 기본 병합 대상도 부모가
됩니다. `--stack`은 부모부터 순서대로 PR을 엽니다. `--from`과 `--on`은
함께 쓰지 않습니다.

### PR이 force-push되어 업데이트가 막혔을 때

```bash
grove pr 42 --replace
```

기존 커밋을 백업 ref에, 커밋하지 않은 변경을 스냅샷에 보존하고 PR의 최신
커밋으로 교체합니다. 출력에 나오는 백업 위치와 복구 명령을 확인하세요.
평소 PR 업데이트에는 `grove sync pr/42`면 충분합니다.

### 리뷰 중인 PR에 직접 수정 내용을 보낼 때

리뷰 워크트리에서 수정한 내용을 커밋한 뒤, PR의 실제 병합 대상 위로 rebase하고
작성자의 브랜치로 push하려면 다음을 실행합니다. 해당 브랜치의 push 권한이
필요합니다.

```bash
grove sync pr/42 --contribute
```

이미 원하는 커밋 상태여서 rebase가 필요 없다면 리뷰 폴더에서 `git push`로
직접 보낼 수도 있습니다.

### 브랜치에서 셋업 설정 자체를 수정할 때

기본값은 로컬 `main/.grove.toml`입니다. PR이나 개발 브랜치에서 수정한 설정을
시험하려면 해당 워크트리의 파일을 선택하세요.

```bash
grove pr 42 --config-source worktree
# 이미 만든 워크트리에도 적용 가능
grove setup feat/login --config-source worktree
```

`add`, `pr`, `setup`에서 사용할 수 있습니다. 선택은 해당 브랜치에 저장되어
이후 셋업·에디터 열기·정리에도 적용됩니다. `copy`와 `link`의 원본은 계속
로컬 `main/`입니다. 기본 설정으로 돌아가려면 실행하세요.

```bash
grove setup feat/login --config-source trunk
```

### 여러 워크트리에서 서버를 실행할 때

grove가 실행하는 셋업·정리·에디터 명령과 `exec`에는 워크트리별 환경 변수가
전달됩니다. 프로젝트 스크립트에서 필요할 때 사용하세요.

| 변수 | 값 |
| --- | --- |
| `GROVE_ROOT` | 워크스페이스 경로 |
| `GROVE_WORKTREE` | 명령이 실행되는 워크트리 경로 |
| `GROVE_BRANCH` | 브랜치 이름 |
| `GROVE_WORKTREE_ID` | 워크트리 식별자. 이름 변경 후에도 유지 |
| `GROVE_PORT` | 같은 워크스페이스 안에서 구분되는 포트 번호 |
| `GROVE_SERVICE_NAME` | 워크트리별 서비스 이름 |
| `GROVE_DATABASE_NAME` | 워크트리별 DB 이름 |

`PORT`와 `COMPOSE_PROJECT_NAME`도 각각 포트와 서비스 이름으로 기본 설정합니다.
셋업·정리 설정의 `env`에 직접 값을 쓰면 그 값이 우선합니다. 예를 들어
`PORT = 3000`을 공통 설정에 넣으면 모든 워크트리가 같은 포트를 사용합니다.

일반 터미널에서 직접 실행하는 명령에는 이 변수가 자동 주입되지 않습니다.
할당된 값을 확인하려면 다음을 실행하세요. `exec`는 모든 워크트리를 순서대로
방문합니다.

```bash
grove exec -- sh -c 'echo "$GROVE_BRANCH: PORT=$PORT DB=$GROVE_DATABASE_NAME"'
```

이 값을 읽도록 앱이나 실행 스크립트를 연결해야 합니다. grove가 DB를 생성하거나
운영체제의 포트를 예약하지는 않습니다. 다른 저장소나 앱과의 포트 충돌은
프로젝트에서 별도로 처리하세요.

### squash merge한 작업이 정리 후보에 없을 때

GitHub의 PR 병합 상태도 조회해 후보를 확인하세요. `gh`가 필요합니다.

```bash
grove prune -n --forge-merged
# 확인한 후보를 실제로 정리
grove prune --forge-merged
```

병합된 PR의 마지막 커밋과 로컬 브랜치의 마지막 커밋이 정확히 같을 때만
GitHub의 병합 판정을 사용합니다. PR 이후 추가한 로컬 커밋이나 커밋하지 않은
변경이 있는 워크트리는 남깁니다. 대화형 화면의 `/prune`은 이 추가 조회를
하지 않습니다.

### fork에서 기여할 때

```bash
grove clone git@github.com:you/repo.git --upstream git@github.com:them/repo.git
```

새 작업과 동기화는 원본 저장소의 기본 브랜치를 기준으로 하고, 개발 브랜치는
내 fork로 push합니다. 이미 클론했다면 `grove upstream <원본-저장소-URL>` 또는
화면의 `/upstream`으로 지정하세요. PR 리뷰 워크트리의 push 대상은 해당 PR의
원본 브랜치입니다.

기본 브랜치는 `origin/HEAD`로 찾고, 그 로컬 브랜치가 추적하는 원격을 기준으로
삼습니다. `upstream` 설정은 원본 원격을 추가하고 기본 브랜치가 그 원격을
추적하도록 하며, `remote.pushDefault`를 `origin`으로 지정합니다.
개발 브랜치의 push 대상은 Git 설정의 `branch.<name>.pushRemote`,
`remote.pushDefault`, 추적 원격, `origin` 순으로 결정합니다.

### 기존 Git 클론을 사용하거나 첫 화면에서 시작할 때

일반 `git clone`으로 받은 저장소 안에서도 `grove`를 사용할 수 있습니다.
이 경우 새 워크트리는 기존 저장소 옆에 `myapp-feat-login` 같은 이름으로
생깁니다. 경로는 `grove path feat/login`으로 확인하세요.

빈 폴더에서 `grove`를 실행하면 URL을 입력받아 그 폴더를 워크스페이스로
만듭니다. 비어 있지 않은 폴더에서는 하위 폴더에 클론합니다. 저장소가 여러 개면
선택 화면이 나타납니다. CLI에서는 해당 저장소로 이동하거나 `-C <path>`로
대상을 지정하세요.

## 문제 해결

| 상황 | 다음에 할 일 |
| --- | --- |
| 워크트리는 생겼는데 설치가 안 됨 | `grove setup <branch>` 실행 후 명령 승인 또는 실패 원인 확인 |
| `.env`를 찾을 수 없다고 나옴 | 기본 브랜치 워크트리에 복사 원본 파일 준비 후 `setup` 재실행 |
| 브랜치에서 바꾼 `.grove.toml`이 적용되지 않음 | `grove setup <branch> --config-source worktree` 사용 |
| `setup stale` 표시 | 설정이나 의존성 파일이 바뀜. `grove setup <branch>` 실행 |
| 개발 브랜치 `sync`가 종료 코드 `4`로 끝남 | 오류 내용에서 미커밋 변경, push 거부 등의 원인 확인 |
| PR force-push 이후 동기화 거부 | [리뷰 워크트리 교체](#pr이-force-push되어-업데이트가-막혔을-때) 참고 |
| 기본 브랜치 동기화 거부 | 로컬 커밋과 원격이 갈라졌는지 확인하고 Git으로 정리한 뒤 재시도 |
| PR 생성·리뷰가 안 됨 | `gh` 설치 및 `gh auth login` 확인 |
| 화면 대신 사용법이 출력됨 | 대화형 터미널에서 `--headless` 없이 실행 |
| `exec`의 옵션이 grove 옵션으로 해석됨 | 실행할 명령 앞에 `--` 추가 |

폴더나 Git 상태가 맞지 않는 것 같으면 다음을 실행하세요.

```bash
grove doctor
```

저장소를 수정하지 않고 문제와 복구 명령을 출력합니다. 기본 브랜치 워크트리
누락, fetch 설정, upstream 설정, 디스크에서 사라진 워크트리, 잘못된 `.git`
경로, 깨진 심볼릭 링크 등을 확인합니다. 잠긴 채 폴더가 삭제된 워크트리에는
정리 전에 필요한 unlock 명령도 안내합니다. 문제가 있으면 종료 코드 `6`,
경고만 있으면 `0`입니다.

## 명령어 찾아보기

전체 옵션은 `grove <command> --help`로 확인하세요. 아래의 `<target>`은 브랜치
이름, 디렉터리 이름 또는 경로입니다. `-C <path>`는 작업할 저장소를 지정합니다.

### 생성과 이동

| 명령 | 용도와 추가 옵션 |
| --- | --- |
| `grove clone <url> [dir]` | 워크스페이스 생성. `init`은 별칭. `-b <branch>`는 기본 브랜치와 함께 지정한 브랜치도 체크아웃 |
| `grove add <branch>` | 워크트리 생성. `--push`로 생성 후 첫 push, `--no-fetch`로 fetch 생략 |
| `grove pr <number 또는 URL 또는 branch>` | PR 리뷰 워크트리 생성·갱신. `--replace`로 기존 작업 보존 후 교체 |
| `grove list` | 워크트리 목록 출력 |
| `grove path [target]` | 워크트리 절대 경로 출력. 대상이 없으면 워크스페이스 루트 |
| `grove open [target]` | 설정된 에디터로 열기 |
| `grove rename <target> <name>` | 브랜치와 디렉터리 이름 변경. `--push`는 새 원격 이름으로 push하며 이전 원격 브랜치는 남김 |

`clone`, `add`, `pr`은 `--no-setup`으로 셋업을 미룰 수 있습니다.
`--from`, `--on`, `--take`와 PR 교체는 [필요할 때 쓰는 옵션](#필요할-때-쓰는-옵션)에
상황별 예시가 있습니다.

### 준비와 동기화

| 명령 | 용도와 추가 옵션 |
| --- | --- |
| `grove setup [target]` | 셋업 재실행. `--all`은 모든 워크트리 |
| `grove sync [target]` | 용도별 동기화. `--all`은 모든 워크트리 |
| `grove rebase [target]` | 직접 고른 베이스 위로 rebase. push하지 않음 |
| `grove exec -- <command>` | 모든 워크트리에서 순서대로 명령 실행. `--fail-fast`로 첫 실패에서 중단 |
| `grove upstream <url>` | fork의 원본 저장소 지정. 기존 URL을 바꾸려면 `--force` |

`setup`, `sync`, `rebase`, `open`, `propose`는 대상을 생략하면 현재 워크트리를
사용합니다. 워크스페이스 루트에서는 대상을 지정하세요.

`rebase`의 베이스는 `--trunk`(기본 브랜치가 따르는 원격),
`--upstream`(해당 작업이 추적하는 원격 브랜치), `--onto <ref>` 중 하나로
고릅니다. 예를 들어 `--onto main`은 로컬 main을 뜻합니다. 생략하면 터미널에서
목록을 보여 주고 선택을 받으며, 비대화형 실행에서는 종료 코드 `2`로 알립니다.

`rebase`는 커밋하지 않은 변경을 잠시 보존하고 결과에 다시 적용합니다.
충돌하면 기본적으로 원래 상태로 되돌립니다. `--no-stash`는 변경이 있을 때
거부하고, `--no-abort`는 충돌 상태를 남깁니다. 출력된 복구 안내를 따라 해결하세요.
`sync`에도 `--no-abort`가 있지만 커밋하지 않은 변경을 옮기는 기능은 없습니다.

`exec`에서 셸 문법을 사용하려면 `sh -c`로 감싸세요.

```bash
grove exec -- git status --short
grove exec -- sh -c 'echo "$GROVE_BRANCH"'
```

### PR 올리기와 스택

| 명령·옵션 | 용도 |
| --- | --- |
| `grove propose [target]` | 브랜치를 push하고 PR 생성 |
| `--draft` | 초안 PR로 생성 |
| `--web` | 브라우저에서 제목·본문 작성 |
| `--title <text> --body <text>` | 제목·본문 직접 지정. `--body`는 `--title`과 함께 사용 |
| `--base <branch>` | PR 병합 대상 직접 지정 |
| `--stack` | 대상 브랜치의 부모부터 순서대로 PR 생성 |
| `grove stack [target]` | 브랜치의 스택과 부모 대비 커밋 차이 표시. `--all`은 모든 스택 |

`propose`는 기본적으로 기본 브랜치로 PR을 엽니다. `add --on`으로 만든 작업은
부모 브랜치가 병합 대상입니다. 이미 열린 PR이 있으면 기존 정보를 알려 주고
push하지 않습니다. 원격보다 뒤처졌다면 먼저 `sync`로 동기화하세요.
`--stack`은 `--base`, `--title`, `--body`, `--web`과 함께 쓰지 않습니다.

### 정리와 복구

| 명령·옵션 | 용도 |
| --- | --- |
| `grove remove <target>` | 워크트리 제거. `rm`은 별칭 |
| `grove prune` | 끝난 워크트리 일괄 제거 |
| `prune -n` / `prune --dry-run` | 제거 후보만 출력 |
| `prune --gone` / `prune --merged` | 원격에서 사라진 작업만 / Git에서 병합을 확인한 작업만 |
| `prune --forge-merged` | GitHub의 PR 병합 상태도 조회 |
| `prune --closed` | 병합 없이 닫힌 PR도 조회. PR과 로컬의 마지막 커밋이 같을 때 후보에 추가 |
| `remove --delete-branch` / `prune --delete-branch` | 워크트리와 함께 로컬 브랜치도 삭제 |
| `remove --no-teardown` | 정리 명령 실행 생략 |
| `grove reset <target>` | 커밋하지 않은 변경을 보존한 뒤 버리기 |
| `grove doctor` | 저장소 상태 진단과 복구 명령 안내 |

`prune`은 변경이 있거나, rebase 중이거나, 잠겼거나, 현재 작업 중인 워크트리를
건너뜁니다. `--no-fetch`로 정리 전 fetch를 생략할 수 있습니다. `remove`는
안전하지 않은 제거를 기본적으로 거부합니다. `--force`는 이 보호를 일부
해제하지만, rebase 중인 워크트리는 제거하지 않습니다.

`reset`은 기본적으로 추적 중인 파일의 변경을 버립니다. `--clean`은 미추적
파일도 포함하고, `--to <ref>`는 다른 커밋으로 되돌립니다. 버린 변경의 복구용
커밋을 출력하므로 `git stash apply <sha>`로 되찾을 수 있습니다. 화면의 `x`는
`reset --clean`에 해당합니다. 브랜치별 최신 사본은 Git 정리 후에도 유지되며,
이전 사본의 장기 보관은 보장하지 않습니다.

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

출력은 명령별 결과 객체 또는 배열입니다. 자주 사용하는 필드는 다음과
같습니다. 판정은 종료 코드입니다: 0이 아니면 실패이고, stderr에 찍힌
내용으로 성공을 추측해서는 안 됩니다.

| 명령 | 읽을 만한 필드 |
| --- | --- |
| `add` | `path`, `dir`, `branch`, `source` (`existing`/`remote`/`new`), `alreadyPresent`, `base`, `baseSha`, `setup` |
| `add`의 `setup` | `copied`, `linked`, `ran`, `missing`, `untrusted`, `failed` |
| `list` | 워크트리마다 한 줄: `dir`, `branch`, `dirty`, `ahead`, `behind`, `finished`, `setupStale`, `setupState`, `review` |
| `propose` | `url`, `number`, `base`, `created` (이미 있었으면 false), `pushed`; `--stack`이면 이것들의 배열, 아래에서 위로 |
| `stack` | `trunk`, 그리고 위에서 아래로 `rows[]`, 각각 `branch`, `parent`, `depth`, `dir` (워크트리가 없으면 없음), 부모 대비 `ahead`/`behind`, `exists`, `current` |
| `reset` | `saved`: 스냅샷의 sha, `git stash apply`용 |
| `sync` | 대상별 결과. 종료 코드 `4`는 push 거부 또는 변경 등으로 동기화를 거부한 경우이므로 오류 내용도 확인 |
| `prune -n` | `entries[]`, 각각 `dir`, `reason`, 그리고 남는 경우 `skipped` |

`setup.untrusted: true`는 `.grove.toml`의 명령이 출력만 되고 실행되지
않았다는 뜻입니다. 이 머신에서 아무도 그 버전의 파일을 승인하지 않았기
때문입니다. `setup.failed`는 명령이 0이 아닌 코드로 끝났을 때 설정되며,
워크트리는 어느 쪽이든 존재합니다. 미승인 명령을 건너뛴 것만으로는 실패 코드가
되지 않으므로 `setup.untrusted`도 확인하세요. `clone`, `add`, `pr`, `setup`의
셋업 명령이 실패하면 종료 코드 `9`로 알립니다.

### 신뢰는 사람의 결정입니다

자동화 전에 사용자가 프로젝트 명령을 확인하고 승인하세요. 화면의 질문에
`y`로 답하거나, 내용을 확인한 뒤 `grove setup main --trust`를 실행합니다.
같은 내용으로 승인된 설정은 에이전트가 워크트리를 만들 때도 적용됩니다.
에이전트가 임의로 `--trust`를 붙여 미승인 명령을 실행하지 않도록 작업 지침에
명시할 수 있습니다.

파일이 승인된 뒤의 전형적인 에이전트 루프:

```bash
grove add agents/refactor --json         # 생성; stdout에서 `path` 읽기
# ... 워크트리에서 작업 ...
grove sync agents/refactor --publish     # 첫 push까지 처리
# 작업이 끝나고 정리하기로 한 뒤
grove remove agents/refactor --delete-branch
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
