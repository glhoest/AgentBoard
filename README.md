# AgentBoard

A repository-backed Kanban for humans and agents, packaged as an agent skill. Requires [Bun](https://bun.sh); no npm dependencies. The human UI is the single self-contained `scripts/board.html` next to `scripts/agentboard.ts` (no build step, no remote assets); `serve` uses it by default.


## Install into a repository

Install [Bun](https://bun.sh) and Git first. Clone this source repository outside the project where you want the board:

```sh
git clone https://github.com/glhoest/AgentBoard.git
cd AgentBoard
bun scripts/agentboard.ts setup /absolute/path/to/your-project
```

Use a quoted absolute path if it contains spaces. The target directory must already exist. On Windows, a path such as `"D:/projects/my-project"` works. No `bun install` or build step is needed.

You can also ask your agent: "Install AgentBoard from `<absolute path to this clone>` into this repo." The agent follows [SKILL.md](SKILL.md) and runs the same setup command.

Setup is idempotent. It vendors the runtime and skill into `.agents/skills/agentboard/`, adds a Claude Code pointer at `.claude/skills/agentboard/SKILL.md`, creates `.agentboard/` if missing, excludes the runtime lock from Git, and adds a marked section to `AGENTS.md`. It updates `CLAUDE.md` when that file exists and does not import `@AGENTS.md`. Development files stay in the source clone. Setup commits nothing.

Then run these commands from your project:

```sh
cd /absolute/path/to/your-project
bun .agents/skills/agentboard/scripts/agentboard.ts create "Try AgentBoard" --criterion "Open the board and move this card"
bun .agents/skills/agentboard/scripts/agentboard.ts serve
```

Open the printed URL to use the board. Keep that terminal running and the URL private. Stop the bridge with Ctrl+C. Review and commit the generated board, skill and guide changes to share them with collaborators. If your repository ignores `.agents/`, decide whether to track the vendored skill or have each collaborator run setup.

When you run the installed CLI, it checks GitHub for a published release and reports an available update on stderr. Successful checks are cached for 24 hours; failed checks retry after one hour. Offline failures do not stop the CLI, and `--quiet` suppresses the check and notice. Copies installed from a source checkout have no release version, so the notice identifies the latest release and says the installed version is unknown. No files are updated automatically.

To update an installed copy, run this command from the project root:

```sh
bun .agents/skills/agentboard/scripts/update.ts
```

It fetches the latest stable GitHub release, verifies the artifact's SHA-256 digest, and replaces the vendored skill. It does not change the board. This replaces the entire vendored skill directory, so keep local customizations elsewhere. If your installed copy predates the updater, first pull this source clone and run `setup` once. Update every copy used with a shared board before newer code reads it, because reads can upgrade the file format. See [Versioning](#versioning). The updater requires network access and a published release with an `agentboard.tar.gz` asset; it reports an error without changing the installation if no suitable release exists.

## Use

```sh
bun /path/to/agentboard.ts init /path/to/project  # setup does this for you
cd /path/to/project
bun /path/to/agentboard.ts create "Add authentication" --priority high --criterion "Users can sign in"
bun /path/to/agentboard.ts --json list
bun /path/to/agentboard.ts claim AB-0123456789AB agent-auth
bun /path/to/agentboard.ts move AB-0123456789AB in-progress
bun /path/to/agentboard.ts ask AB-0123456789AB "Which session store?" --author agent-auth
bun /path/to/agentboard.ts --json questions       # open questions across the board
bun /path/to/agentboard.ts answer AB-0123456789AB TH-0123456789AB "Redis" --author alice
bun /path/to/agentboard.ts serve                  # open the printed URL
```

Replace the example IDs with the IDs returned by create and ask. Global flags (`--root`, `--json`, `--quiet`) go before the command. Run `--help` for command options. Output is JSON; `--json` makes it compact (`grill` prints plain text unless `--json`). Errors go to stderr; exit code 2 indicates a conflict, 1 other failure, and 2 a usage error. `--` ends the options, so a text that starts with `-` can follow it.

Feature commands: `feature-create TITLE [--status S] [--description D]`, `feature-edit ID [--revision N] [--title T] [--status S] [--description D] [--archive|--unarchive]`, `feature-move ID STATUS [--revision N]`, `feature-show ID`, and `features [--include-archived]`. `feature-show` adds progress, counts and linked cards to the feature. `features` returns `{features, dangling}`; each feature summary has `id`, `title`, `status`, `archived`, `progress` and `counts`. Link cards with `create --feature ID` or `edit ID --feature ID`, clear with `edit ID --clear-feature`, and filter with `list --feature ID`.

Commands: `init [path]`, `setup [path]`, `list [--all] [--status S] [--assignee A]`, `show ID`, `create TITLE …`, `edit ID …`, `move ID STATUS`, `claim ID ASSIGNEE`, `serve [--port P] [--ui FILE]`, and for threads:

- `ask ID BODY [--author A]`, `answer ID QUESTION_ID BODY [--author A]`, `comment ID BODY [--author A] [--reply-to ENTRY_ID]`: append an entry and print the updated item (the new entry is the last of `thread`). The author defaults to the `AGENTBOARD_AUTHOR` environment variable, else null.
- `edit-entry ID ENTRY_ID [--body B] [--author A]`: change an entry's body and/or author; prints the updated item.
- `thread ID`: prints the thread array.
- `questions`: prints the open questions of non-archived cards as `{item, title, status, question}` objects, ordered by card ID, then thread order.
- `grill [ID]`: a plain-text grilling brief (title, status, description, acceptance criteria, open questions) for the non-archived cards in the `needs-grilling` column, or for one card. With `--json`: `[{id, title, status, priority, assignee, description, acceptanceCriteria, openQuestions}]`. Fails if the board has no `needs-grilling` column and no ID is given.

All write commands accept `--revision N`. After every command except `setup`, `serve`, help and usage errors, one line goes to stderr while non-archived cards have open questions: `N open question(s) on AB-…, AB-… — run "questions"` (at most 10 IDs, then `(+K more)`). stdout and the exit code are unaffected; the line is skipped if the board cannot be read. `--quiet` suppresses it.

## Contract

The project root contains `.agentboard/board.json` and one file per item at `.agentboard/items/AB-<12 uppercase hex>.json`. Commit `.agentboard/` to share the board. Keep secrets out of it. Random IDs contain 48 bits; collisions are checked. Root file `.agentboard.lock` is runtime state; exclude it from Git and never delete it while tools run. Initialization excludes it via `.git/info/exclude` if `.git` is a directory; configure your own ignore for worktrees.

```ts
type Priority = 'low' | 'medium' | 'high' | 'urgent';
type Criterion = { text: string; done: boolean };
type Entry = { id: string; kind: 'comment' | 'question' | 'answer'; author: string | null; body: string;
 replyTo: string | null; createdAt: string; updatedAt: string };
type Item = { version: '1.1.0'; id: string; revision: number; title: string; status: string;
 priority: Priority; assignee: string | null; labels: string[]; description: string;
 acceptanceCriteria: Criterion[]; notes: string; createdAt: string; updatedAt: string; archived: boolean;
 feature: string | null; thread: Entry[] };
type Column = { id: string; name: string };
type Board = { version: '1.1.0'; name: string; columns: Column[]; featureColumns: Column[] };
type Feature = { version: '1.0.0'; id: string; revision: number; title: string; status: string; description: string; createdAt: string; updatedAt: string; archived: boolean };
type Snapshot = { config: Board; items: Item[]; features: Feature[]; hashes: Record<string, string> };
type Changes = Partial<Pick<Item, 'title' | 'status' | 'priority' | 'assignee' | 'labels' | 'description' | 'acceptanceCriteria' | 'notes' | 'archived' | 'feature'>>;
```

All item fields are mandatory, no extras. Filenames must match IDs. Times are UTC `YYYY-MM-DDTHH:mm:ss.sssZ`. Text may contain Markdown and is untrusted. Title is 1–300 characters; assignee up to 120; up to 50 unique nonempty labels of up to 80 characters; description and notes at most 100,000 characters; up to 200 criteria with nonempty text up to 1,000 characters. Status must match a column ID. Column IDs are unique lowercase slugs matching `^[a-z][a-z0-9-]{0,39}$`. The first column is the default. Edit config only with writers stopped; never remove a column in use, including a feature column used by a feature. Removing one makes reads and feature moves fail with the feature ID and status. Changes replace fields, including entire arrays; `thread` cannot be set through `Changes` or create. No manual order; sort deterministically. Archive rather than delete. `board.json` has exactly the four keys above; `featureColumns` (default planned / active / done) follow the column rules and are reserved for features. `init` creates the columns backlog, needs-grilling ("Needs grilling"), todo, in-progress, blocked and done. `feature` is null or `FT-<12 uppercase hex>`. Features live in `.agentboard/features/FT-<12 uppercase hex>.json`, created on the first feature write. Feature titles are 1–300 characters, descriptions at most 100,000, and statuses must match `featureColumns`. Feature files use revision and timestamps like cards. Linking requires an existing, non-archived feature; clearing a link always works. Archiving a feature leaves its card links intact. `dangling` lists non-archived card IDs whose feature is missing or archived; those links remain readable. Progress counts linked non-archived cards with status `done` out of all linked non-archived cards, with counts per card status. Set feature status by hand; archive features instead of deleting them.

The thread holds at most 500 entries, appended in order, editable (body, author) but never deleted. Entry IDs are `TH-<12 uppercase hex>`, unique within the card. Author is null or 1–120 characters; body is 1–20,000 characters, not only whitespace. A `question` has `replyTo: null`; an `answer` replies to an earlier `question` of the same card; a `comment` may reply to any earlier entry. A question is **open** until an `answer` replies to it; nothing else closes it. A question may receive more than one answer and stays closed after the first. Asking a question on an archived card is refused; unarchive it first. Every thread write is an ordinary item write: it bumps `revision` and `updatedAt` and is checked against `--revision` or the bridge hash. Entry timestamps equal the item's `updatedAt` of that write.

### Versioning

Every file carries a semver string in `version`; a missing version or the integer `1` (the original format) means 1.0.0. Minor and patch versions are additive (older files upgrade by filling defaults); a major version transforms data through a written upgrade step. Readers are strict: a file with a newer version than the reader knows, even a newer minor, is rejected with "written by a newer AgentBoard … update this copy". There is no tolerant reading of unknown fields.

Upgrade on read: when the CLI or bridge reads an older file, it validates the upgraded form and rewrites the file in the current format right away, under the lock, atomically. It re-reads the file under the lock, so concurrent readers upgrade each file once. Files that are already current are read without the lock. An invalid older file is reported, never rewritten. A pure format upgrade changes nothing but the format: `revision` and `updatedAt` stay, so a `--revision` from an earlier read still applies. The file bytes, and therefore the bridge hash, do change: a bridge client holding a hash of the old bytes gets 409 and reloads (the bridge upgrades before hashing, so clients reading through it never hold such a hash). `setup` checks an existing board without rewriting it.

Upgrades so far: card 1.0.0 → 1.1.0 appends `feature: null` and `thread: []`. `board.json` 1.0.0 → 1.1.0 inserts the needs-grilling column after `backlog` (first if there is none) unless a column with that ID exists, and adds the default `featureColumns`; the version records that this ran, so a needs-grilling column removed later is not re-added. Old copies of AgentBoard reject upgraded files loudly: update every vendored copy with `setup` before newer code touches a shared board.

## Concurrency

CLI and bridge coordinate writes using an OS lock on `.agentboard.lock` (byte-range lock on Windows, `flock` on POSIX; released automatically if the process dies), check supplied revisions under that lock, and atomically replace individual files. Bridge edits require a revision and a SHA-256 hash of the exact item file bytes; both are checked inside the lock. Hashes also flag manual changes that did not increment the revision; CLI edits without `--revision` apply to the latest item. Pass a revision for updates based on an earlier read. `claim` checks/sets the assignee under the lock, rejecting an item assigned to someone else; claims do not expire or prevent normal edits. Use `edit --unassign` to release. Manual changes, direct browser writes, separate checkouts and machines do not share a lock. Git conflicts and semantically conflicting edits require review. Network filesystem behavior can differ.

## Bridge

`serve` binds to IPv4 loopback and prints a URL with a per-process token in the fragment. Keep the URL private. It serves the HTML given by `--ui` at `/` (default: `board.html` next to `agentboard.ts`); `--port` defaults to a free port. The UI reads the fragment and sends `Authorization: Bearer <token>` on API calls. Host, Origin (when present), token, content type and body size are checked; no CORS headers are emitted. Keep the bridge running.

- `GET /api/board`: 200 `{config,items,features,hashes}`, including archived. Hashes maps each item and feature ID to its lowercase SHA-256 hex digest of its exact on-disk UTF-8 bytes.
- `POST /api/features`: `{title, status?, description?}` creates a feature (201).
- `PATCH /api/features/<id>`: `{revision, hash, changes:{title?,status?,description?,archived?}}` updates a feature (200), with the same conflict checks as cards.
- `POST /api/items`: JSON object of writable fields including title; 201 full item. Defaults: first column, medium priority, null assignee, empty arrays/text, not archived.
- `PATCH /api/items/<id>`: `{ "revision": 1, "hash": "<64 lowercase hex characters>", "changes": { "status": "done" } }`; 200 full item. A changed hash or stale revision: 409 `{error,code:"conflict"}`. Invalid request: 400 `code:"invalid"`; access failure 403; missing route 404; IO error 500.
- `POST /api/items/<id>/thread`: `{ "revision": 2, "hash": "…", "entry": { "kind": "question", "body": "…", "author": "alice", "replyTo": null } }` (`author` and `replyTo` optional); 201 full item, the new entry last in `thread`.
- `PATCH /api/items/<id>/thread/<entryId>`: `{ "revision": 3, "hash": "…", "changes": { "body": "…", "author": null } }` (either or both); 200 full item. Both thread routes use the same checks and status codes as `PATCH /api/items/<id>`; an unknown entry is 400.
- `GET /api/board` upgrades older files on disk before hashing them, so it always returns current-format items (with their threads) and hashes of the current bytes.
- No push endpoint: poll at 1–2 seconds and on focus. Compare hashes to detect changes even if revisions do not change. A malformed item causes the entire snapshot to fail visibly. Preserve unsaved drafts.

## CI and releases

GitHub Actions runs separate CLI and library tests (`bun test tests/ts`) and Chrome end-to-end tests (`bun test tests/ui.test.ts`) on Windows for pushes and pull requests. Chrome is required so the browser suite cannot be skipped. You can also run CI manually from the Actions tab.

To publish a release, run the **Release** workflow on `main` from the Actions tab and enter a new stable tag such as `v1.0.0`. It runs the full test suite first, then creates a GitHub release and tag at the selected commit with generated release notes. The release includes `agentboard.tar.gz`, used by installed copies for updates, in addition to GitHub source archives. The workflow requires Actions to be enabled and permission to create repository contents.
See [CONTRIBUTING.md](https://github.com/glhoest/AgentBoard/blob/main/CONTRIBUTING.md) for pull requests, commit titles and testing.

## Developing the skill

This folder is the source. `tests/` and `docs/` stay here and are not vendored. Run `bun test` from this folder (Chrome/Chromium is needed for the browser suite, which is skipped if missing; `CHROME_PATH` overrides detection, `AB_SHOTS=<dir>` keeps screenshots, `AB_CLI` overrides the CLI command under test).

| Tests | What they prove |
| --- | --- |
| `tests/ts/args.test.ts` | Every command and option parses; `--opt=value`, `--`, abbreviations, choices, integer checks, help and usage errors. |
| `tests/ts/format.test.ts` | Format snapshots: CLI output and exact file bytes on a deterministic board, and the v1 legacy fixture upgrading to the snapshot bytes. Read its header before updating a snapshot. |
| `tests/ts/versions.test.ts`, `upgrade.test.ts` | Version parsing, newer-version rejection, the upgrade pipeline; upgrade-on-read in store, CLI and bridge, exactly once under concurrent readers. |
| `tests/ts/thread.test.ts` | Thread rules and limits, open questions, the thread CLI commands and exit codes, the stderr notice, `grill`, `init` columns. |
| `tests/ts/store.test.ts`, `workflow.test.ts` | Exact file bytes, validation, create/update/claim lifecycle with conflicts, concurrent CLI claims and creates. |
| `tests/ts/lock.test.ts` | The OS lock serializes processes, is released on error and when the holder is killed. |
| `tests/ts/bridge.test.ts`, `serve.test.ts` | Bridge auth, Host checks, status codes, stale revision/hash conflicts, thread routes, CLI and bridge sharing one project. |
| `tests/ts/setup.test.ts`, `cli.test.ts` | `setup` vendoring and idempotency; CLI output format and exit codes. |
| `tests/ui.test.ts` | Real Chrome drives `board.html` against the real bridge on a temporary project. |

`board.html` also has an optional direct mode (File System Access API, Chromium desktop) for when no bridge is running. It cannot use the advisory lock or compare-and-swap, so concurrent writes can be lost; the page says so. Prefer the bridge.

Direct mode cannot create a feature file exclusively because the browser file API has no atomic exclusive create; a second existence check narrows the race.
The CLI rejects cards with an unknown status, so their progress cannot be compared against CLI output.

In the board filter, “No feature” includes cards linked to a missing or archived feature.

## Watch board changes

The optional local watcher compares board snapshots and runs an action when selected changes are observed. Start it explicitly in a trusted environment; it does not run as part of `serve` or setup. For example, from a project with the skill installed, print new open-question events:

```sh
bun .agents/skills/agentboard/scripts/watch.ts --on question.opened -- bun -e "console.log(await new Response(Bun.stdin.stream()).text())"
```

Replace the command after `--` with a program and its arguments. It runs from the board root, directly without a shell, and receives one UTF-8 JSON batch on stdin. Relative executable paths are resolved from the board root. On Windows use a real executable or `bun script.ts`; `.cmd` and `.bat` wrappers are rejected at startup. The action inherits the watcher's environment except the two webhook variables described below. It must treat board data as untrusted, including when passing it to an agent: do not interpolate event data into a shell command or treat board text as instructions. Retrieve a card by ID with the CLI if the action needs its contents.

For an HTTP destination, set `AGENTBOARD_WEBHOOK_URL` in the watcher's environment, optionally set `AGENTBOARD_WEBHOOK_AUTHORIZATION` to the complete Authorization header value, then run:

```sh
bun .agents/skills/agentboard/scripts/watch.ts --on question.opened --webhook
```

Use HTTPS, or HTTP only for `localhost`, `127.0.0.1`, or `[::1]`. URL credentials and redirects are rejected. Non-2xx responses and timeouts stop the watcher; response bodies, URLs and authorization values are not logged by the watcher. Keep URLs and credentials outside the repository, command history, and board. Anyone with access to the process environment may be able to read them. For custom headers, signatures, retries, or a different transport, use a trusted process action instead.

The watcher accepts `--root DIR`, `--interval MS` (default 2000), `--timeout MS` (default 60000), and repeated `--on TYPE` filters; times must be 100–86400000 milliseconds. Without a filter all types are delivered. `--help` lists them. One batch looks like this:

```json
{"schema":1,"at":"2026-01-01T12:00:00.000Z","events":[{"type":"question.opened","id":"AB-0123456789AB","questionId":"TH-0123456789AB"}]}
```

Types are `card.created`, `card.updated`, `card.removed`, `card.status`, `card.assignee`, `question.opened`, `question.closed`, `feature.created`, `feature.updated`, `feature.removed`, and `board.updated`. Update events include `fields`, the changed top-level field names; status and assignee events include `before` and `after`. Full cards and question text are not included. Card and feature archives are updates, not removals. `question.opened` means a question became open on a non-archived card; `question.closed` means it ceased to be open, including when answered, archived, or removed. Restoring a previously answered or archived question may open it again. Git checkouts and manual file edits can produce removal and creation events. Several types may describe the same change; use filters to avoid duplicate work.

Startup takes a baseline and emits nothing for existing state. A snapshot is read under the board lock, which is released before the action runs; a large board or frequent polling can delay writers. Changes are compared by content, even when a revision is unchanged. Older formats are upgraded in memory only. A malformed snapshot produces a warning and is retried against the last good snapshot; a newer unsupported format stops the watcher. Actions run one at a time, and the next poll occurs only after an action finishes. A failing or timed-out action stops the watcher, and Ctrl+C stops it and terminates a running process action. A batch over 1 MiB or more than 60 action batches in a minute stops the watcher to limit accidental loops. Actions that edit the board may trigger themselves; filter events and design actions to be idempotent.

This is snapshot polling, not a durable event log: multiple edits between polls or during an action can collapse into one change or disappear entirely. Changes while the watcher is stopped are not replayed. A failed or interrupted action is not retried and may have taken effect before failing; there is no delivery guarantee. Separate watchers operate independently and can duplicate actions. Direct browser writes and Git operations do not acquire the CLI lock, so a poll may observe their intermediate state. If the watcher crashes or is forcibly killed, a process action may continue running. A watcher waiting for a held board lock cannot process Ctrl+C until the lock is released; a stuck lock holder may require the watcher process to be terminated externally.

T3 Code's [webhook automations](https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md#webhook-automations) can receive JSON requests. Create a webhook task whose prompt treats `{{body}}` as untrusted data and supply its URL through `AGENTBOARD_WEBHOOK_URL`; enable authentication appropriate to the deployment. AgentBoard's built-in webhook does not sign requests, so a task requiring signatures needs a custom process action. A local T3 webhook task was tested end to end with a `card.updated` event from this repository's vendored watcher; public T3 Connect delivery and signatures were not tested. The process interface also permits adapters for other agent harnesses or notification tools; the local process and local HTTP receiver paths are covered by tests.

## Supported environments and limitations

The current verification baseline is Windows 11 with Bun and Chrome. The POSIX lock implementation has not yet been verified on Linux or macOS. Desktop Chromium supports the optional direct folder mode; use the local bridge for coordinated CLI and UI writes. Direct mode cannot share the CLI lock and concurrent writes can be lost.

Cards, comments and feature descriptions are ordinary tracked JSON files. Anyone with repository access can read their contents and Git history. Keep credentials and private conversations out of the board.

## License

[MIT](LICENSE), copyright Gaston Lhoest. Keep the copyright and permission notice when redistributing the software, including vendored copies.
