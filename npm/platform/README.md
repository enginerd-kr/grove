# @enginerd-kr/grove, platform binary

This package holds the compiled `grove` binary for one platform. It is an
optional dependency of [`@enginerd-kr/grove`](https://www.npmjs.com/package/@enginerd-kr/grove),
which is the package to install:

```bash
npm install -g @enginerd-kr/grove
```

npm picks this package by its `os` and `cpu` fields; there is nothing to
require or run from it directly.
