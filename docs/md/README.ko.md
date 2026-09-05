<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../logo-dark.svg">
  <img src="../logo-light.svg" alt="" width="128">
</picture>

# grove

**브랜치마다 독립된 작업 폴더, 반복되는 개발 환경 준비는 자동으로.**

grove는 Git 워크트리 관리자입니다. 저장소를 한 번 클론한 뒤, 개발과 PR 리뷰를 각각의 폴더에서 진행합니다. 프로젝트에 `.grove.toml`을 설정하면 새 폴더의 파일 복사와 의존성 설치도 자동으로 실행합니다.

[![ci](https://github.com/enginerd-kr/grove/actions/workflows/ci.yml/badge.svg)](https://github.com/enginerd-kr/grove/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)
[![release](https://img.shields.io/github/v/release/enginerd-kr/grove?color=brightgreen)](https://github.com/enginerd-kr/grove/releases)

[설치](#설치) · [빠른 시작](#빠른-시작) · [사용 설명서](USAGE.ko.md) · [개발](#개발)

[English](../../README.md) · [한국어](README.ko.md)

</div>

<p align="center">
  <img src="../screens/demo.gif" alt="18초 데모: 워크트리를 추가하고, .grove.toml이 셋업하고, 기본 브랜치의 변경을 반영하는 모습" width="100%">
</p>

## 설치

```bash
brew install enginerd-kr/tap/grove
# 또는 npm으로 설치 (macOS, Linux; Node 18+)
npm install -g @enginerd-kr/grove
```

설치 없이 실행하려면 `npx @enginerd-kr/grove`를 사용하세요.

## 빠른 시작

아래 URL을 사용할 저장소의 URL로 바꾸세요.

```bash
grove clone https://github.com/org/repo.git
cd repo
grove add feat/login
cd feat/login
```

이제 `feat/login` 폴더에서 코드를 수정하고 평소처럼 Git으로 커밋하면 됩니다.
프로젝트에 셋업 명령이 있으면 grove가 처음 실행하기 전에 내용을 보여 주고
승인을 받습니다. 설정 파일이 없어도 워크트리는 만들 수 있습니다.

전체 작업 목록을 보려면 워크스페이스 안에서 `grove`를 실행하세요.
`a`로 새 작업을 만들고, `s`로 선택한 작업을 동기화합니다.

## 평소 개발 흐름

아래 명령은 `repo/`에서 실행하는 예시입니다.

| 할 일 | 명령 |
| --- | --- |
| 새 작업 시작 | `grove add feat/login` |
| 내 작업으로 PR 열기 | `grove propose feat/login` |
| 개발 브랜치 동기화 | `grove sync feat/login` |
| 다른 사람의 PR 리뷰 | `grove pr 42` |
| 리뷰 중인 PR 업데이트 | `grove sync pr/42` |
| 끝난 작업 정리 후보 확인 | `grove prune -n` |

`propose`와 `pr`은 GitHub CLI인 `gh`가 필요합니다.
처음 올리는 브랜치는 `propose`가 push까지 처리합니다.
아직 원격에 없는 브랜치를 `sync`로 먼저 올리려면 `--publish`를 붙입니다.

**개발 브랜치의 `sync`는 rebase 후 원격 브랜치가 있으면 push합니다.**
원격 브랜치가 없으면 기본 브랜치를 기준으로 로컬 동기화합니다. PR 리뷰 워크트리의
`sync`는 PR의 최신 커밋을 받아오고, 기본 브랜치의 `sync`는 fast-forward만
수행합니다. [동기화 설명](USAGE.ko.md#동기화는-무엇을-하나요)에서 차이를 확인하세요.

## 폴더는 어떻게 나뉘나요?

```text
repo/             # 워크스페이스: 여기서 grove 실행
  .bare/          # 모든 워크트리가 공유하는 Git 저장소
  .git            # Git 저장소 위치를 가리키는 파일
  main/           # 기본 브랜치와 공통 셋업 파일
  feat/login/     # 로그인 기능 개발
  pr/42/          # PR #42 리뷰
```

코드 수정과 커밋은 `main/`, `feat/login/`, `pr/42/` 같은 워크트리 안에서 합니다.
`main`은 기본 브랜치 이름의 예시입니다. 기본 브랜치가 `master`라면 해당 이름을
사용하세요. 새 작업은 기본적으로 최신 원격 기본 브랜치에서 시작합니다.
로컬 `main`을 먼저 갱신하거나 그 폴더로 이동할 필요는 없습니다.

## 프로젝트 셋업은 한 번 설정하세요

기본 브랜치의 `.grove.toml`에 프로젝트 준비 방법을 적습니다.
다음은 Bun 프로젝트의 최소 예시입니다. `run`을 프로젝트의 설치 명령으로 바꾸세요.

```toml
[setup]
run = ["bun install"]
```

`.env`도 가져와야 한다면 `[setup]`에 `copy = [".env"]`를 추가하고,
로컬 `main/.env`에 복사할 파일을 준비하세요. `.env`는 `.gitignore`에 넣습니다.
의존성은 각 워크트리에 설치하고, 패키지 관리자 캐시를 활용하세요.

이후 `clone`, `add`, `pr`에서 셋업을 적용합니다. 설치가 실패하거나 나중에
설정이 바뀌면 `grove setup feat/login`으로 다시 실행할 수 있습니다.
[셋업 설정과 재실행](USAGE.ko.md#프로젝트-셋업)에서 자세히 설명합니다.

## 다음에 읽을 내용

- [사용 설명서](USAGE.ko.md): 처음 클론해서 PR을 올리고 정리하기까지
- [대화형 화면](USAGE.ko.md#대화형-화면): 키보드로 워크트리 관리하기
- [필요할 때 쓰는 옵션](USAGE.ko.md#필요할-때-쓰는-옵션): 변경 옮기기, 스택, PR 교체, 브랜치별 셋업
- [문제 해결](USAGE.ko.md#문제-해결): 설치가 안 되거나 동기화가 막힐 때

## 개발

grove 자체에 기여할 때 사용하는 명령입니다.

```bash
bun install
bun run grove
bun run grove:dev
bun test
bun run lint
bun run typecheck
bun run build
bun run compile
bun run npm:build
bun run npm:smoke
bun run screenshots
```
