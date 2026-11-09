# Agent guide

AgentBoard is a repository-backed Kanban for humans and agents, packaged as an agent skill: a Bun CLI (`scripts/agentboard.ts` + `scripts/lib/`), a local HTTP bridge, and one self-contained web UI (`scripts/board.html`). Read `HANDOVER.md` first (state, open work, feature design), then `README.md` (the file contract, concurrency and bridge API).

- Bun only, no npm dependencies, no build step. Readable multi-line TypeScript.
- The files in `.agentboard/` are the integration surface. Never break existing boards: new versions must read old files and upgrade them deliberately (see `HANDOVER.md`).
- `board.html` treats all board data as untrusted: build DOM with `textContent`/`createElement`, never `innerHTML`; relative API URLs; never leak the token.
- `setup` vendors this folder into other repositories, skipping development material (`scripts/lib/setup.ts`, `skipped`). Add new root-level development files to that list.
- Dogfooding: this repository tracks its own work on its own board (section below). `.agents/skills/agentboard/` is a gitignored install built from this source; if it is missing or older than your changes, run `bun scripts/agentboard.ts setup .` to refresh it. Never edit it directly. The board in `.agentboard/` is the real one, so keep it readable by the vendored copy.
- For code or behavior changes, run `bun test` (all suites, including `tests/ui.test.ts`) before reporting, and state exact pass/fail counts. For board-only changes, verify the result with the AgentBoard CLI. For documentation-only changes, review the edited text and diff.

<!-- agentboard:begin -->
## AgentBoard
Project work is tracked on the repository AgentBoard in `.agentboard/` (commit it). Agents: follow `.agents/skills/agentboard/SKILL.md`; CLI `bun .agents/skills/agentboard/scripts/agentboard.ts --help`. Humans: run `bun .agents/skills/agentboard/scripts/agentboard.ts serve` and open the printed URL.
<!-- agentboard:end -->
