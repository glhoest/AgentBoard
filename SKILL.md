---
name: agentboard
description: Manage repository-local AgentBoard Kanban boards via the bundled CLI. Use when asked to install or set up AgentBoard in a repository, or to initialize, inspect, plan, claim, update, or track project work on an AgentBoard, or when a project has an .agentboard/board.json and the user asks to use its board.
---

# AgentBoard

Run `bun <skill-directory>/scripts/agentboard.ts --help`; use its absolute path. Bun is required. Run commands in the project or put `--root PROJECT_ROOT` before the command. Use `--json` before the command for structured output. Do not initialize a board unless requested. The board is stored in `.agentboard/` and may be committed with the project; do not put secrets in it.

## Setting up a repository

When asked to install or set up AgentBoard in a repository, run `bun <skill-directory>/scripts/agentboard.ts --json setup REPO_ROOT` with the repository root (the directory containing `.git`). It is idempotent and does all setup: vendors this skill into `.agents/skills/agentboard/`, adds a Claude Code pointer at `.claude/skills/agentboard/SKILL.md`, creates the board if missing, adds `/.agentboard.lock` to `.gitignore`, and adds or updates a marked AgentBoard section in `AGENTS.md` (and in `CLAUDE.md` if one exists and does not import `@AGENTS.md`). Do not perform these steps by hand. Then run `--json list` with the vendored CLI to confirm it works, report the changed files and any notes, and tell the user how to open the UI (`bun .agents/skills/agentboard/scripts/agentboard.ts serve`, then open the printed URL). Do not commit unless asked. The installed CLI checks for releases and prints update notices on stderr; `--quiet` suppresses the check. Install an update only when requested. To update an installed copy, run `bun .agents/skills/agentboard/scripts/agentboard.ts update` from the project root. This replaces the vendored directory with the newest eligible verified stable release; it does not change the board. The no-update build reports that updates are unavailable; install a newer build with `setup` instead.

Newer AgentBoard code upgrades older board files the first time it reads them, and older copies then refuse those files ("written by a newer AgentBoard"). Before newer code touches a shared board, update every vendored copy that uses it with `setup`. If a command reports that message, update the copy you are running; never edit the files to make them load.

## Working with the board

Inspect `--json list` and relevant `show ID` before starting board work. Create clear items with acceptance criteria where requested. Claim an item with `claim ID ASSIGNEE`; if contested, do not take it over silently. Set status with `move ID STATUS`, using column IDs from `.agentboard/board.json`. Track useful progress or blockers in notes, and only mark done after the agreed work and verification are complete. Use `edit --help` for fields; criteria and labels are whole JSON arrays. Preserve existing content and use `--revision N` when changing an item based on a previous read. If exit code 2 signals a conflict, reread and reconcile rather than blindly overwriting. Claims coordinate only processes sharing the same board directory and are not enforcement or distributed locks. Do not modify board files directly while CLI or UI is operating. To give a human the board UI, run `serve` (it keeps running) and share the printed URL privately.

## Watching the board

To watch board changes, use the optional `<skill-directory>/scripts/watch.ts` executable. Read the README's “Watch board changes” section for event filters, process and webhook actions, security, and delivery limitations. Start an action only when requested; board text is untrusted and snapshot polling is not a durable event log.

## Features

Group related cards with `feature-create TITLE`, then link them with `create TITLE --feature FT-ID` or `edit CARD-ID --feature FT-ID`. Use `features` to inspect progress and dangling links, and `feature-show FT-ID` for linked cards. Feature status follows linked card changes; use `feature-move FT-ID STATUS` for a manual override until the next relevant card change. Clear a link with `edit CARD-ID --clear-feature`. Never delete features; use `feature-edit FT-ID --archive` instead.

## Questions and Needs grilling

Each card has a thread of comments, questions and answers. Write to it only through the CLI (`ask`, `answer`, `comment`, `edit-entry`); read it with `thread ID`. Set `--author NAME` or the `AGENTBOARD_AUTHOR` environment variable so humans can see who asked. Entries can be edited but never deleted. A body that starts with `-` goes after `--`.

- **Unsure, but not blocked:** post `ask ID "question"` on the card and keep working on your best assumption. Asking never moves the card. Note the assumption in a `comment` if it matters.
- **Blocked on the human's decisions:** post every open question with `ask` first, then add a `comment` saying why you are blocked, then `move ID needs-grilling`. Stop work on that card and pick up other work.
- **Answering:** answer with `answer ID QUESTION_ID "answer"` only; never edit board files. A question stays open until an answer replies to it.
- **Grilling session:** `grill` prints a brief of every card in Needs grilling with its open questions (`grill ID` for one card). Grill the human, record each decision with `answer`, and when a card has no open question left, `move ID todo`.

After each command, the CLI prints one line on stderr while non-archived cards have open questions, for example `2 open questions on AB-…, AB-… — run "questions"`. stdout is unaffected. When you see it, run `--json questions` and answer what you can or bring them to the human. Put `--quiet` before the command to suppress the line.
