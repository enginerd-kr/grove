<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../logo-dark.svg">
  <img src="../logo-light.svg" alt="" width="128">
</picture>

# grove

**바로 쓸 수 있는 상태로 도착하는 워크트리.**

grove는 프로젝트가 정의한 셋업을 갖춘 Git 워크트리 관리자입니다. 한 번만 클론하고, 자유롭게 브랜치를 만들고, .grove.toml이 새 워크트리 하나하나를 바로 쓸 수 있는 개발 환경으로 만들도록 맡기세요.

[![ci](https://github.com/enginerd-kr/grove/actions/workflows/ci.yml/badge.svg)](https://github.com/enginerd-kr/grove/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)
[![release](https://img.shields.io/github/v/release/enginerd-kr/grove?color=brightgreen)](https://github.com/enginerd-kr/grove/releases)

[설치](#설치) · [빠른 시작](#빠른-시작) · [프로젝트 셋업](#프로젝트-셋업-grovetoml) · [개발](#개발)

[English](../../README.md) · [사용 가이드 (한국어)](USAGE.ko.md)

</div>

<p align="center">
  <img src="../screens/demo.gif" alt="18초 데모: 워크트리를 추가하고, .grove.toml이 셋업하고, 트렁크 아래로 다시 동기화하는 모습" width="100%">
</p>

## 이게 정확히 뭔가요?

Git 워크트리를 쓰면 저장소 하나가 여러 작업 디렉터리를 가질 수 있습니다. grove는 그것을 관리되는 작업 공간으로 바꿉니다.

- bare 클론 하나가 저장소를 한 번만 저장합니다
- 모든 브랜치는 예측 가능한 자기만의 디렉터리를 갖습니다

실제로 grove는 여러 브랜치를 동시에 살려 두기 위한 도구입니다. 기능 브랜치, 핫픽스, 리뷰용 브랜치, 실험, 코딩 에이전트 샌드박스가 각각 바로 실행할 수 있는 자기 디렉터리에 놓입니다.

## 설치

```bash
brew install enginerd-kr/tap/grove
```

## 빠른 시작

```bash
grove clone https://github.com/org/repo.git
cd repo

grove add feat/login
grove add fix/prod-crash
grove
```

grove clone은 관리되는 저장소를 만듭니다. grove add는 브랜치 워크트리를 만들고 .grove.toml을 적용합니다. 인자 없이 grove를 실행하면 대화형 관리 화면이 열립니다.

## grove로 하는 일들

- **지금 브랜치를 잃지 않고 새 브랜치를 시작합니다.** grove add feat/search는 예측 가능한 경로에 진짜 워크트리를 만듭니다.
- **이미 타이핑을 시작한 뒤에 브랜치를 나눕니다.** grove add feat/search --take는 커밋하지 않은 변경을 새 워크트리로 옮기고, 이전 워크트리는 깨끗하게 남깁니다.
- **변경 위에 변경을 쌓습니다.** grove add feat/step-2 --on feat/step-1은 베이스를 기억하고, sync는 그 베이스를 거쳐 리베이스합니다.
- **풀 리퀘스트를 실제 체크아웃에서 리뷰합니다.** grove pr 42는 번호, URL, 브랜치 이름을 받습니다.
- **코딩 에이전트마다 자기 작업 공간을 줍니다.** agents/refactor, agents/tests, agents/ui-copy — 두 번째 클론은 필요 없습니다.
- **같은 로컬 셋업을 반복해서 다시 만들지 않습니다.** .grove.toml이 .env를 복사하고, 의존성 폴더를 링크하고, 환경 변수를 설정하고, 설치를 실행하고, 에디터를 엽니다.
- **저장소 전체를 한눈에 봅니다.** grove는 브랜치, 변경이 있는 워크트리, 동기화 차이, 최근 활동을 보여 줍니다.

## 그냥 git worktree를 쓰면 안 되나요?

날것의 git worktree는 강력하지만, 일상적인 작업은 여전히 수동입니다.

- 각 브랜치 디렉터리를 어디에 둘지 정하기
- 어느 폴더에 커밋하지 않은 변경이 있는지 기억하기
- 모든 브랜치를 원격과 기본 브랜치에 맞춰 동기화하기
- .env, 인증서, 로컬 설정처럼 무시되는 파일을 새 체크아웃마다 복사하기
- 의존성을 다시 설치할지, 심볼릭 링크로 공유할지 결정하기

grove는 이 선택들을 반복 가능하게 만듭니다. 브랜치 feat/login은 feat/login/이 되고, UI는 무엇이 바뀌었는지 보여 주며, 저장소 스스로 새 워크트리를 쓸 수 있게 만드는 방법을 설명합니다.

## 프로젝트 셋업 (.grove.toml)

저장소는 자기만의 셋업 레시피를 가질 수 있습니다. 다른 파일과 똑같이 추적되고 리뷰되므로, 누군가 설명하기 전에 새 클론이 먼저 셋업됩니다.

기본 브랜치에 .grove.toml을 추가하세요.

```toml
[setup]
copy = [".env", "certs", "config/local.json"]
link = ["node_modules"]
env = { PORT = 3000, API_HOST = "http://localhost:3000" }
run = ["bun install"]
open = "code ."

[teardown]
run = ["docker compose down"]
```

이제 모든 새 워크트리가 이 파일로 채워집니다.

- **copy**는 기본 브랜치 워크트리에서 파일이나 디렉터리를 가져옵니다. 트렁크 쪽이 우선합니다.
- **link**는 의존성 폴더 같은 공유 경로를 심볼릭 링크로 연결하고, 워크트리에 이미 있는 것은 그대로 둡니다.
- **env**는 셋업 명령에 전달됩니다.
- **run**은 새 워크트리에서 셸 명령을 순서대로 실행합니다.
- **open**은 에디터를 엽니다.

<p align="center">
  <img src="../screens/add.svg" alt="grove가 워크트리를 추가하고 .grove.toml 셋업 단계를 적용하는 모습" width="100%">
</p>

## 레이아웃

bare 클론 하나와 그 옆에 놓인 평범한 Git 워크트리들:

```text
repo/
  .bare/           # Git 객체와 ref, 한 번만 저장
  .git             # Git 명령을 .bare로 향하게 함
  main/            # 기본 브랜치 워크트리
  feat/login/      # 브랜치 feat/login
  fix/prod-crash/  # 브랜치 fix/prod-crash
  agents/refactor/ # 브랜치 agents/refactor
```

## grove가 아닌 것

- Git의 대체품이 아닙니다. 모든 체크아웃은 평범한 Git 워크트리입니다.
- 패키지 관리자가 아닙니다. 셋업 명령은 여러분의 것입니다: bun install, uv sync, just setup.
- 비밀 관리자가 아닙니다. .grove.toml은 커밋되고 리뷰되므로, 진짜 비밀은 넣지 마세요.

## 개발

```bash
bun install
bun run grove
bun run grove:dev
bun test
bun run lint
bun run typecheck
bun run build
bun run compile
bun run screenshots
```
