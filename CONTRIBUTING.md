# Contributing

AgentBoard uses Bun and has no npm dependencies or build step. Install Bun and Chrome or Chromium before developing. Clone the repository, create a branch from `main`, and make your changes there.

Run the full suite before opening a pull request:

```sh
bun test
```

The browser suite requires Chrome or Chromium; set `CHROME_PATH` if it is not detected. CI runs CLI and library tests and browser end-to-end tests as separate jobs. If you change the skill source, run `bun scripts/agentboard.ts setup .` to refresh this repository's vendored copy. Keep existing boards compatible and follow [AGENTS.md](AGENTS.md) for the file and UI constraints.

Open a pull request against `main`. Use a [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) title, for example `fix: preserve update notices` or `feat(ui): filter cards`. Supported types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `revert`. An optional scope and `!` for breaking changes are allowed. Explain behavior changes and how you tested them in the PR description.

Pull requests are squash-merged. The PR title becomes the squash commit title; individual branch commits need not follow the convention. GitHub checks the PR title and tests before merging. Keep secrets and private project data out of committed board files.
