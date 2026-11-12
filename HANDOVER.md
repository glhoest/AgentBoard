# Handover

Written 2026-10-31 at the end of the session that built this tool, for the first thread in this repository. Read `AGENTS.md` (rules) and `README.md` (file contract, concurrency, bridge API) alongside it.

## Watcher update

The optional `scripts/watch.ts` polls validated snapshots and dispatches filtered board changes to a process or webhook. See README “Watch board changes” for the event schema, safety and delivery limits. It uses an in-memory baseline, does not modify board files, and cannot recover intermediate changes. A local process action and a local T3 webhook task were dogfooded against this repository's card AB-D3EB216B8BCF; automated tests use a local webhook receiver. Public T3 Connect delivery and request signing remain untested.

## Defect tracker

Issues live in `.agentboard/issues/`; `scripts/lib/issues.ts` owns their validation, lifecycle and work synchronization. The CLI, bridge, UI and watcher expose the tracker. See README “Defect triage” for the format and workflow. Old copies ignore issues and cannot synchronize them, so update all installed copies before using the tracker on a shared board.

## 1. What this is

AgentBoard is a repository-backed Kanban for humans and AI agents, packaged as an agent skill:

| Path | Role |
| --- | --- |
| `SKILL.md`, `agents/openai.yaml`, `assets/icon.svg` | Skill definition (Claude Code / Codex) |
| `scripts/agentboard.ts` | CLI entry: `init setup list show create edit move claim serve` |
| `scripts/lib/types.ts` | Shared types, constants, `BoardError` / `Conflict` |
| `scripts/lib/store.ts` | Read/validate/write cards; atomic writes; hashes |
| `scripts/lib/lock.ts` | Cross-process OS lock (`bun:ffi`: `LockFile` byte 0 on Windows, `flock` on POSIX) |
| `scripts/lib/args.ts` | Argument parser (argparse-like: `--opt=value`, unique prefixes, usage errors exit 2) |
| `scripts/lib/setup.ts` | Installs the skill + board into a repo (idempotent) |
| `scripts/lib/serve.ts` | Local HTTP bridge (`127.0.0.1`, token in URL fragment) serving `board.html` + JSON API |
| `scripts/board.html` | The whole web UI: one self-contained file, no build, no remote assets |
| `tests/` | Development only (never vendored): `tests/ts/*.test.ts`, `tests/ui.test.ts` (real Chrome via `tests/cdp.ts`) |
| `docs/CLAUDE_UI_PROMPT.md` | The original brief the web UI was built from |

Install into any repo: tell an agent "Install AgentBoard from `<path-to-agentboard>` into this repo"; it runs `bun <this>/scripts/agentboard.ts --json setup <repo>` (see `SKILL.md`). Repos then hold a vendored copy in `.agents/skills/agentboard/` — never edit those; change this repo and re-run `setup`.

## 2. State (verified 2026-10-31, Windows 11, Bun 1.4, Chrome)

- Work is tracked on this repo's own board (dogfooding, see `AGENTS.md`); branch `develop` for work, `main` kept stable.
- `bun test` → **182 pass, 0 fail** (14 files, ~105 s) after all feature stages (63 before them, 59 at handover). Includes the browser suite (32 tests: board, create/edit, CLI changes appearing live, conflict + draft preservation, real 409, archive/restore, filters, keyboard, native drag-and-drop, narrow layout, six-column layout at 1400/1200/1024/390, long content, offline/reconnect, XSS probes, thread panel incl. stale posts, drafts and polling, direct File System Access mode via OPFS incl. upgrade-on-read and thread writes).
- Covered elsewhere: exact file bytes for tricky text, validation rules, revision/hash conflicts, claims, concurrent CLI `claim` → exactly one winner, 10 concurrent `create`s, lock released on throw and on killed holder, bridge 403/400/404/409 (incl. manual byte edit caught by hash), CLI + bridge on one project, parser, `setup`.
- Run a board UI: `bun scripts/agentboard.ts init <dir>` then `bun scripts/agentboard.ts --root <dir> serve` and open the printed URL.

History in one paragraph: the tool started as a Python CLI with a contract (`README.md`); the web UI was built against it; the CLI was then ported to Bun by a graph of agents (interfaces first, parallel module briefs, a file-level interop test proving Python and Bun could share boards byte-for-byte), and finally Python was removed entirely. The files are still byte-compatible with the old Python version, and the lock still interoperates with it.

## 3. Known gaps — fix first

1. ~~Lock error wrapping~~ — fixed 2026-10-31 (card AB-04B20E2A368C): only acquire/release failures become "Cannot lock"; callback errors propagate unchanged. Follow-ups on the board: the bridge maps server bugs and lock failures to 400 `invalid`; `posixLock` spins on persistent `flock` errors.
2. POSIX lock path (`flock` via libc) is implemented but untested — no macOS/Linux run yet.
3. Direct File System Access mode in `board.html` is tested with an OPFS handle, never with the real folder picker.
4. Line endings: with Git `core.autocrlf=true` (set on this machine), a target repo's `.agentboard/` JSON files can be checked out with CRLF. They stay valid, but their bytes and hashes differ from what the tool writes (LF), and the tool rewrites them as LF on edit. Consider having `setup` add `/.agentboard/** -text` (or `eol=lf`) to the target repo's `.gitattributes`. This repo pins LF via its own `.gitattributes`.
5. Code style is uneven: `store.ts`, `serve.ts` and `lock.ts` are dense; `args.ts`, `setup.ts`, `agentboard.ts` are readable. Tidy when touching them.

## 4. Next: new features (designed, grilled 2026-10-31, not started)

Requested by the user:
- **Needs grilling:** a place where items go when they need grilling by the user — collaborative grilling with the Matt Pocock-style `grilling` skill.
- **Per-item Q&A / comment thread:** agents post questions on an item; the human answers them, or a grilling session fills them in.
- **Features (milestones):** "a Kanban on top of the Kanban": each card can be assigned to a feature; progress is tracked per feature.
- **Hard requirement:** existing boards must keep loading in new versions and be upgraded into the new format.

### Compatibility facts (verified, current code)

- Items are validated strictly: exactly the 14 known keys and `version: 1`; `board.json` must be `version: 1`. So **any new item field or version makes current copies reject those files** — loudly ("Invalid item structure or version"), never silently corrupting.
- Current copies ignore extra top-level keys in `board.json` and any new directory under `.agentboard/` (they only read `board.json` and `items/*.json`). The old Python version behaves the same.

### Decisions (from the grilling session with the user)

**Versioning (foundation, build first).**
- Every file carries a semver string: cards, `board.json`, feature files. A missing version or today's integer `1` reads as `1.0.0`.
- Minor/patch = additive: older files upgrade by filling defaults only (new optional fields; patch for clarifications). Major = existing data must be transformed (rename, restructure) and needs a written upgrade step. Before shipping a breaking change, first try to make it non-breaking.
- Readers are strict: a file with a version newer than the reader knows (even a newer minor) is rejected loudly. No tolerant reading of unknown fields.
- Upgrade on read: when new code (CLI, bridge **and** `board.html`, incl. direct mode) reads an older file, it rewrites it in the current format right away, under the lock. Always write the current version; do not keep writing the old 14-key format. Consequence, accepted: old vendored copies fail loudly on any board that new code has touched — update every vendored copy with `setup` before using new code on a shared board.
- No explicit `upgrade` command (replaces the old design D).
- **Format snapshot tests:** a test suite runs chosen CLI commands on a fixed board and compares the output (and resulting file bytes) to verified snapshots from the current version. A failing snapshot means: evaluate, bump minor/patch, or, if breaking, either make it non-breaking or add the upgrade step to CLI and HTML.
- Q&A and features ship together as card format **1.1.0** (`thread` and `feature` fields with defaults `[]` and `null`).

**Q&A thread on a card.**
- Lives **inside the card file** as a `thread` array (not separate files). Every post/edit bumps the card's revision and hash; the user accepts that a post can conflict with an open UI edit (drafts are preserved; see the edit-lock and reconciliation cards for mitigation).
- Entry: `{id, kind: "comment" | "question" | "answer", author: string | null, body, replyTo: id | null, createdAt, updatedAt}`. Author is optional free text (1–120 chars when present). Proposed limits (not grilled): ≤ 500 entries per card, body ≤ 20,000 chars.
- Entries are **editable, never deleted**.
- A question is open until an `answer` entry replies to it. There is no resolve-without-answer.
- All writes go through the CLI/bridge (validation + lock); the grilling skill answers with the CLI (`answer ID QUESTION_ID "…"`).
- Surface: CLI `ask`, `answer`, `comment`, `edit-entry` (name TBD), `thread ID`, `questions` (open questions across the board, `--json`); bridge endpoints for posting/editing entries; threads arrive with the card in `GET /api/board`. UI: thread panel in the card editor and an open-question badge on cards.
- **Notice:** every CLI call prints one stderr line while questions are open: count + card IDs + "run `questions`". stdout/JSON stays unchanged. `--quiet` suppresses it.

**Needs grilling = a column** `needs-grilling` ("Needs grilling") after `backlog`.
- Asking a question never moves a card (an in-progress card stays in progress). An agent moves a card to Needs grilling explicitly when it is blocked on the human's decisions; `SKILL.md` says when.
- The grilling session answers through the CLI and, when no questions remain open, moves the card to `todo`.
- `grill [ID]` prints the cards in the column with their open questions as a grilling brief.
- New boards get the column from `init`; existing boards get it from the `board.json` 1.1.0 upgrade-on-read (inserted after `backlog`, else first; added once — the version bump records it, so a column the user removes is not re-added).

**Features.**
- One concept, "feature" (no separate milestones). Own files `.agentboard/features/FT-<12 hex>.json`: `{version: "1.0.0", id, revision, title, status, description, createdAt, updatedAt, archived}`.
- A card has **at most one** feature: typed field `feature: "FT-…" | null` (card 1.1.0).
- Feature status follows linked cards automatically; manual moves last until a relevant card change. See README "Automatic feature status" for the current rules and recovery behavior. Progress counts linked non-archived cards in the last card column.
- UI: a features view laid out as its own Kanban with progress bars; board filter by feature.
- Features get no Q&A thread for now.

**Separate features raised in the grilling (own cards, not designed yet):**
- Visual edit locks: an agent (or the CLI automatically) marks a card as being edited; the mark lasts 1 minute after the last change and is shown in the UI. Ties into reconciliation.
- Diff-based reconciliation of conflicting edits (instead of only rejecting a stale write).
- Webhook notification of new open questions, for tooling that supports it.

**Status:** all stages done (2026-11-01). Stage 1: versioning + upgrade-on-read + format snapshot tests, card 1.1.0 with the Q&A thread (CLI, bridge, stderr notice, `questions`), `board.json` 1.1.0 with the needs-grilling column and `grill`. Stage 2: `board.html` understands 1.1.0 (bridge and direct mode), thread panel, open-question badge, six-column layout, `ask` refused on archived cards. Stage 3: features (files in `.agentboard/features/`, CLI `feature-*`/`features`/`--feature`, bridge routes, features Kanban + chips + filter + feature editor, direct mode). Atomic writes retry transient rename failures on Windows. Open work lives on the board (Needs grilling: edit locks and reconciliation; backlog: POSIX/folder-picker tests, bridge error mapping, UI polish, webhook).

### Suggested order

Versioning foundation + format snapshot tests → card 1.1.0 (`thread`, `feature`) and `board.json` 1.1.0 → Q&A CLI/bridge/notice/`questions` → Needs grilling column + `grill` → features CLI → UI for each, with tests at every step (`bun test`, browser suite). Update `README.md` (contract + API) and `SKILL.md` (agent workflow: when to ask, when to move to Needs grilling, answering via CLI) as part of each step.

## 5. How work went well here

- One project, small briefs per agent, ordered by an implementation graph: shared types/interfaces first (GPT-6.1-Terra, low), then parallel module briefs (GPT-6-Luna, high), each owning distinct files and running its own tests. When Luna produced nothing runnable, Terra wrote a runnable skeleton for Luna to finish; Sonnet/Terra handled loose ends.
- A separate referee writes acceptance tests; the orchestrator re-runs every claimed result itself (several agent reports were wrong).
- Parity is defined at the file level (the integration surface) first, behavior second.
- Pitfalls seen: markdown backticks inside JS template literals (parses, fails at runtime); `fsync` on a read-only descriptor fails on Windows; Bun's 5 s default test timeout is too short for multi-process tests (`setDefaultTimeout`).
