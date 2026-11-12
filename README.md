# AgentBoard

AgentBoard is a Kanban board for humans and agents. It stores the board as files in your repository and ships as an agent skill. It needs [Bun](https://bun.sh) and has no npm dependencies. The human UI is one self-contained file, `scripts/board.html`, next to `scripts/agentboard.ts`. It has no build step and loads no remote assets, and `serve` uses it by default.


## Install into a repository

Install [Bun](https://bun.sh) and Git first. Clone this source repository outside the project that will hold the board:

```sh
git clone https://github.com/glhoest/AgentBoard.git
cd AgentBoard
bun scripts/agentboard.ts setup /absolute/path/to/your-project
```

The target directory must already exist. Quote the absolute path if it contains spaces. On Windows, a path such as `"D:/projects/my-project"` works. You don't need `bun install` or a build step.

You can also ask your agent: "Install AgentBoard from `<absolute path to this clone>` into this repo." The agent follows [SKILL.md](SKILL.md) and runs the same setup command.

You can run setup more than once with the same result. It does the following:

- copies the runtime and skill into `.agents/skills/agentboard/`;
- adds a Claude Code pointer at `.claude/skills/agentboard/SKILL.md`;
- creates `.agentboard/` if it is missing;
- excludes the runtime lock from Git;
- adds a marked section to `AGENTS.md`, and to `CLAUDE.md` if that file exists and does not import `@AGENTS.md`.

Development files stay in the source clone. Setup commits nothing.

Then run these commands from your project:

```sh
cd /absolute/path/to/your-project
bun .agents/skills/agentboard/scripts/agentboard.ts create "Try AgentBoard" --criterion "Open the board and move this card"
bun .agents/skills/agentboard/scripts/agentboard.ts serve
```

Open the printed URL to use the board. Keep that terminal running and keep the URL private. Press Ctrl+C to stop the bridge. To share the board with collaborators, review and commit the generated board, skill and guide changes. If your repository ignores `.agents/`, decide whether to track the vendored skill or have each collaborator run setup.

### Updates

The standard build checks for new releases when the installed CLI runs. It caches each check result for 24 hours, failures included, and `--quiet` turns the check off. The check never installs anything.

To update the installed skill, run:

```sh
bun .agents/skills/agentboard/scripts/agentboard.ts update
```

The command checks right away and installs the newest stable release that was published at least seven days ago. `--force` allows a newer stable release regardless of age. Neither mode installs an older version than the one you have. If the installed version is unknown, the updater refuses to run, because it cannot rule out a downgrade; install from a known source with setup instead.

Before replacing the skill, the updater checks the download's size and SHA-256 hash. It does not touch the board. A network error, or no eligible release, leaves the installation as it was. The update replaces local changes to the skill, so keep any customizations elsewhere. Update every copy that shares a board before newer code upgrades that board.

Each release also contains `agentboard-no-update.tar.gz`, a build without self-update or automatic network checks. To install it, extract it and run its CLI's `setup`. Board commands work as usual, and `update` reports that updates are unavailable. You install newer builds of it by hand.

If an existing copy still has the old standalone `scripts/update.ts`, run `setup` once from a newer source copy. That moves it to the CLI `update` command.

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

Replace the example IDs with the IDs that `create` and `ask` return. Global flags (`--root`, `--json`, `--quiet`) go before the command. Run `--help` to see each command's options.

Output is JSON, and `--json` makes it compact. `grill` is the exception: it prints plain text unless you pass `--json`. Errors go to stderr. Exit code 1 means a failure, and exit code 2 means a conflict or a usage error. `--` ends the options, so text that starts with `-` can follow it.

Commands: `init [path]`, `setup [path]`, `list [--all] [--status S] [--assignee A]`, `show ID`, `create TITLE …`, `edit ID …`, `move ID STATUS`, `claim ID ASSIGNEE` and `serve [--port P] [--ui FILE]`.

Thread commands:

- `ask ID BODY [--author A]`, `answer ID QUESTION_ID BODY [--author A]` and `comment ID BODY [--author A] [--reply-to ENTRY_ID]` append an entry and print the updated item. The new entry is the last one in `thread`. The author defaults to the `AGENTBOARD_AUTHOR` environment variable, or null if it is unset.
- `edit-entry ID ENTRY_ID [--body B] [--author A]` changes an entry's body, author or both, and prints the updated item.
- `thread ID` prints the thread array.
- `questions` prints the open questions on non-archived cards as `{item, title, status, question}` objects, sorted by card ID and then by thread order.
- `grill [ID]` prints a plain-text grilling brief for one card, or for every non-archived card in the `needs-grilling` column. The brief has the title, status, description, acceptance criteria and open questions. With `--json` it prints `[{id, title, status, priority, assignee, description, acceptanceCriteria, openQuestions}]`. Without an ID, it fails if the board has no `needs-grilling` column.

Feature commands:

- `feature-create TITLE [--status S] [--description D]`
- `feature-edit ID [--revision N] [--title T] [--status S] [--description D] [--archive|--unarchive]`
- `feature-move ID STATUS [--revision N]`
- `feature-show ID` prints the feature with its progress, counts and linked cards.
- `features [--include-archived]` prints `{features, dangling}`. Each feature summary has `id`, `title`, `status`, `archived`, `progress` and `counts`.

Link a card to a feature with `create --feature ID` or `edit ID --feature ID`, remove the link with `edit ID --clear-feature`, and filter cards with `list --feature ID`.

All write commands accept `--revision N`.

While any non-archived card has open questions, every command prints one line to stderr, for example `N open question(s) on AB-…, AB-… — run "questions"`. It lists at most 10 card IDs, then `(+K more)`. The exceptions are `setup`, `serve`, help and usage errors. The line does not change stdout or the exit code, and the CLI skips it if it cannot read the board. `--quiet` turns it off.

## Contract

The project root contains `.agentboard/board.json` and one file per item at `.agentboard/items/AB-<12 uppercase hex>.json`. Commit `.agentboard/` to share the board, and keep secrets out of it. IDs are random 48-bit values, and the tool checks for collisions.

`.agentboard.lock` in the project root is runtime state. Exclude it from Git and never delete it while tools are running. Initialization adds it to `.git/info/exclude` when `.git` is a directory. In a worktree, where `.git` is a file, add your own ignore rule.

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

### Cards

Every item field is required, and extra fields are not allowed. A file's name must match its ID. Times are UTC in the form `YYYY-MM-DDTHH:mm:ss.sssZ`. Text may contain Markdown and is untrusted.

| Field | Limit |
| --- | --- |
| `title` | 1–300 characters |
| `assignee` | up to 120 characters |
| `labels` | up to 50 unique, nonempty labels of up to 80 characters each |
| `description`, `notes` | up to 100,000 characters each |
| `acceptanceCriteria` | up to 200 criteria, each with nonempty text of up to 1,000 characters |

`status` must match a column ID. `feature` is null or `FT-<12 uppercase hex>`. `Changes` replace whole fields, including entire arrays. You cannot set `thread` through `Changes` or `create`. Cards have no manual order, so sort them deterministically. Archive cards instead of deleting them.

### Board and columns

`board.json` has exactly the four keys shown in `Board`. Column IDs are unique lowercase slugs matching `^[a-z][a-z0-9-]{0,39}$`. The first column is the default for new cards. `init` creates the columns backlog, needs-grilling ("Needs grilling"), todo, in-progress, blocked and done.

`featureColumns` follow the same rules and hold feature statuses only. They default to planned, active and done.

Only edit `board.json` while no writers are running. Never remove a column that is in use, including a feature column that a feature uses. If you do, reads and feature moves fail with an error that names the feature ID and status.

### Features

Features live in `.agentboard/features/FT-<12 uppercase hex>.json`. The directory appears on the first feature write. A feature title is 1–300 characters, a description at most 100,000 characters, and the status must match a feature column. Feature files carry a revision and timestamps, the same as cards. Archive features instead of deleting them.

You can only link a card to an existing, non-archived feature. Clearing a link always works. Archiving a feature leaves its card links in place. `dangling` lists the IDs of non-archived cards whose feature is missing or archived, and those links stay readable.

Progress counts the linked non-archived cards in the last card column, out of all linked non-archived cards. It also reports a count per card status. Linked cards set the feature status, as described in [Automatic feature status](#automatic-feature-status).

### Threads

A card's thread holds at most 500 entries, in the order they were added. You can edit an entry's body and author, but you cannot delete an entry. Entry IDs are `TH-<12 uppercase hex>` and are unique within the card. `author` is null or 1–120 characters. `body` is 1–20,000 characters and cannot be only whitespace.

- A `question` has `replyTo: null`.
- An `answer` replies to an earlier `question` on the same card.
- A `comment` may reply to any earlier entry.

A question is open until an `answer` replies to it, and nothing else closes it. A question can get more than one answer and stays closed after the first. The CLI, bridge and direct mode refuse a question on an archived card, so unarchive the card first.

Every thread write is an ordinary item write. It increments `revision`, updates `updatedAt`, and is checked against `--revision` or the bridge hash. A new entry's timestamps, and an edited entry's `updatedAt`, equal the item's `updatedAt` from that write.

### Versioning

Every file has a semver string in `version`. A missing version, or the integer `1` from the original format, means 1.0.0. Minor and patch versions only add things, so an older file upgrades by filling in defaults. A major version changes existing data and needs a written upgrade step.

Readers are strict. They reject a file with any newer version than they know, even a newer minor version, with "written by a newer AgentBoard … update this copy". They never ignore unknown fields.

When the CLI or bridge reads an older file, it upgrades the file on the spot:

- It takes the lock, re-reads the file, validates the upgraded form, and atomically rewrites the file in the current format. Because of the re-read, concurrent readers upgrade each file only once.
- It reads files that are already current without the lock.
- It reports an invalid older file and never rewrites it.
- A format upgrade keeps `revision` and `updatedAt`, so a `--revision` from an earlier read still applies.
- The file's bytes change, and so does its bridge hash. A bridge client that holds a hash of the old bytes gets a 409 and reloads. The bridge upgrades files before hashing them, so clients that read through it never hold such a hash.

`setup` checks an existing board without rewriting it.

Upgrades so far:

- Cards 1.0.0 to 1.1.0 append `feature: null` and `thread: []`.
- `board.json` 1.0.0 to 1.1.0 adds the default `featureColumns`. It also inserts the needs-grilling column after `backlog`, or first if there is no `backlog`, unless a column with that ID already exists. The version records that this upgrade ran, so the column does not come back if you remove it later.

Old copies of AgentBoard reject upgraded files with an error. Update every vendored copy with `setup` before newer code touches a shared board.

### Automatic feature status

The CLI and bridge recalculate a feature's status whenever a linked card is created, moved, linked, unlinked, archived or restored. They only recalculate non-archived features.

The last card column counts as done. If every linked non-archived card is done, the feature moves to its last column. Otherwise, the unfinished card in the furthest-right column sets the feature's column. The calculation maps that card column's position onto the feature columns proportionally and rounds down. Done cards do not affect the status while any card remains unfinished. Custom columns follow their configured order. When `in-progress` exists and `active` is an intermediate feature column, cards before `in-progress` map before `active`; a card at or past it moves the feature to at least `active`.

Some cases leave the status alone:

- A feature with no linked cards keeps its status, and so does an archived feature.
- When you unlink or relink a card whose old feature is missing or damaged, the tool skips that feature so you can still clear the link.
- A manual feature move stays until the next card change that triggers a recalculation. Unrelated edits and reads do not recalculate, so old boards keep their statuses until then.

An automatic change increments the feature's revision and updates its timestamp, so a feature edit based on an older read conflicts.

The CLI and bridge do the calculation under the board lock and validate every new status before writing the card. They then write the card file and each feature file separately. If a feature write fails after the card was saved, the error names the saved card and the affected features. The bridge returns a 500 with `code: "feature_sync_failed"`, `itemId` and `featureIds`. To recover:

1. Reload the board before you retry anything.
2. Do not repeat a failed `create`, because the card already exists.
3. For a non-archived card, run `move CARD-ID STATUS` with its saved status. That recalculates its current feature.
4. For an archived card, a status retry does not recalculate, so set each listed feature's status by hand with `feature-move`.
5. Check each listed feature and move it by hand if needed, especially the previous feature after a relink.

An interruption or a failed feature write can leave statuses inconsistent until the next card change that triggers a recalculation. The UI's direct mode uses the same calculation but cannot coordinate with other writers.

## Concurrency

The CLI and bridge coordinate writes with an OS lock on `.agentboard.lock`: a byte-range lock on Windows and `flock` on POSIX. The OS releases the lock if the process dies. Under the lock, the tools check any supplied revision and then atomically replace individual files.

Bridge edits must include a revision and a SHA-256 hash of the item file's exact bytes, and the bridge checks both inside the lock. The hash also catches manual edits that did not increment the revision. A CLI edit without `--revision` applies to the latest version of the item, so pass a revision when your update is based on an earlier read.

`claim` checks and sets the assignee under the lock and rejects an item that someone else already holds. Claims never expire and do not block normal edits. Release a claim with `edit --unassign`.

Manual edits, direct browser writes, separate checkouts and other machines do not share the lock. Review Git conflicts and edits that conflict in meaning by hand. Network filesystems may behave differently.

## Bridge

`serve` listens on IPv4 loopback and prints a URL with a per-process token in the fragment. Keep the URL private and keep the bridge running. It serves the HTML file given by `--ui` at `/`, by default `board.html` next to `agentboard.ts`. `--port` defaults to a free port.

The UI reads the token from the fragment and sends `Authorization: Bearer <token>` with API calls. The bridge checks the Host header, the Origin header when present, the token, the content type and the body size. It sends no CORS headers.

- `GET /api/board` returns 200 `{config,items,features,hashes}`, including archived items. `hashes` maps each item and feature ID to the lowercase SHA-256 hex digest of its exact UTF-8 bytes on disk. The bridge upgrades older files on disk before hashing them, so it always returns items in the current format, with their threads, and hashes of the current bytes.
- `POST /api/features` takes `{title, status?, description?}` and creates a feature (201).
- `PATCH /api/features/<id>` takes `{revision, hash, changes:{title?,status?,description?,archived?}}` and updates a feature (200). It runs the same conflict checks as the card routes.
- `POST /api/items` takes a JSON object of writable fields, which must include `title`, and returns 201 with the full item. Defaults are the first column, medium priority, a null assignee, empty arrays and text, and not archived.
- `PATCH /api/items/<id>` takes `{ "revision": 1, "hash": "<64 lowercase hex characters>", "changes": { "status": "done" } }` and returns 200 with the full item.
- `POST /api/items/<id>/thread` takes `{ "revision": 2, "hash": "…", "entry": { "kind": "question", "body": "…", "author": "alice", "replyTo": null } }` and returns 201 with the full item. `author` and `replyTo` are optional. The new entry is the last one in `thread`.
- `PATCH /api/items/<id>/thread/<entryId>` takes `{ "revision": 3, "hash": "…", "changes": { "body": "…", "author": null } }`, with either change or both, and returns 200 with the full item. An unknown entry ID returns 400.

Error responses for the item and thread routes:

| Status | Meaning |
| --- | --- |
| 409 `{error,code:"conflict"}` | The hash changed or the revision is stale. |
| 400 `code:"invalid"` | The request is invalid. |
| 403 | Access check failed. |
| 404 | No such route. |
| 500 | IO error, or `feature_sync_failed` (see [Automatic feature status](#automatic-feature-status)). |

The bridge has no push endpoint. Clients should poll every 1–2 seconds and when the window gets focus. Compare hashes to detect changes, because a change does not always increment the revision. A malformed item makes the whole snapshot fail with a visible error. Keep unsaved drafts when reloading.

## CI and releases

On every push and pull request, GitHub Actions runs the CLI and library tests (`bun test tests/ts`) and the Chrome end-to-end tests (`bun test tests/ui.test.ts`) as separate jobs on Windows. CI requires Chrome so the browser suite cannot be skipped. You can also start CI by hand from the Actions tab.

To publish a release, run the Release workflow on `main` from the Actions tab and enter a new stable tag such as `v1.0.0`. The workflow runs the full test suite first. It then creates the tag and a GitHub release at the selected commit, with generated release notes. The release contains `agentboard.tar.gz` and `agentboard-no-update.tar.gz` next to GitHub's source archives. The workflow needs Actions enabled and permission to create repository contents.

See [CONTRIBUTING.md](https://github.com/glhoest/AgentBoard/blob/main/CONTRIBUTING.md) for pull requests, commit titles and testing.

## Developing the skill

This folder is the source. `tests/` and `docs/` stay here, and setup does not copy them into other repositories. Run `bun test` from this folder. The browser suite needs Chrome or Chromium and is skipped if neither is found. These environment variables change the test run:

- `CHROME_PATH` sets the browser instead of detecting it.
- `AB_SHOTS=<dir>` keeps screenshots in that directory.
- `AB_CLI` sets the CLI command under test.

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

`board.html` also has an optional direct mode for when no bridge is running. It uses the File System Access API, which desktop Chromium supports. Direct mode cannot use the lock or compare-and-swap, so concurrent writes can be lost, and the page warns about this. Prefer the bridge.

Notes on direct mode and the UI:

- When issue files exist, direct mode refuses work-card status changes, including drag-and-drop. Use the bridge so linked issues follow work completion and reopening. Issue submission and evidence also require the bridge.
- Direct mode cannot create a feature file exclusively, because the browser file API has no atomic exclusive create. A second check that the file does not exist makes the race window smaller.
- The CLI rejects cards with an unknown status, so you cannot compare their progress against CLI output.
- The board's "No feature" filter includes cards linked to a missing or archived feature.

## Defect triage

The issue tracker stores defects and their evidence in Git alongside the work board. Feature requests belong on the work board. Agents use the CLI (`issues`, `issue-show`, `issue-create`, `issue-edit`, `issue-evidence`, and `issue-promote`); run a command with `--help` for its options. Humans can submit defects and evidence in the UI. Reports are repository data: do not include secrets or private customer data.

Issues move through five fixed stages: New, Smoking rack, Gathering data, Ready for work, and Closed. Smoking rack holds reports awaiting further real-world instances; Gathering data is for investigation. Triage uses judgment, not a fixed reproduction count. Before promotion, record observed and expected behavior, reproduction steps or why they are unavailable, and actionable acceptance criteria. Promotion retains the report and evidence and creates or links a normal work item. Multiple issues can link to the same work item.

Each issue is a JSON file in `.agentboard/issues/`, named `IS-<12 uppercase hex>.json`. Version 1.0.0 stores its ID, revision, title, status, observed and expected behavior, reproduction text, criteria and evidence arrays, work item and duplicate IDs, closure reason, and creation and update timestamps. A missing issues directory means there are no issues, so existing boards remain readable. Issue changes use the board lock and revision checks; as with work cards, Git operations and direct browser writes do not share that lock.

An agent can close a duplicate, invalid report, or non-defect with a reason and a link to the duplicate where applicable. Linked issues close when their work is completed and reopen when it is reopened. New evidence reopens a closed issue for triage even if its old work remains done; follow-up work or a triage resolution is required. Missing or archived work links remain visible for triage. Triage can be run by an external scheduler or triggered by watcher issue events; AgentBoard does not run a scheduler.

## Watch board changes

The optional local watcher compares board snapshots and runs an action when it sees selected changes. Start it yourself, in an environment you trust. Neither `serve` nor setup starts it. For example, this prints new open-question events from a project with the skill installed:

```sh
bun .agents/skills/agentboard/scripts/watch.ts --on question.opened -- bun -e "console.log(await new Response(Bun.stdin.stream()).text())"
```

Replace the command after `--` with your program and its arguments. The watcher runs it from the board root, without a shell, and writes one UTF-8 JSON batch to its stdin. It resolves relative executable paths from the board root. On Windows, use a real executable or `bun script.ts`. The watcher refuses `.cmd` and `.bat` wrappers at startup. The action inherits the watcher's environment, minus the two webhook variables described below.

The action must treat board data as untrusted, including when it passes the data to an agent. Do not put event data into a shell command, and do not treat board text as instructions. If the action needs a card's contents, fetch the card by ID with the CLI.

To send events to an HTTP endpoint, set `AGENTBOARD_WEBHOOK_URL` in the watcher's environment. Optionally, set `AGENTBOARD_WEBHOOK_AUTHORIZATION` to the full value of the Authorization header. Then run:

```sh
bun .agents/skills/agentboard/scripts/watch.ts --on question.opened --webhook
```

The URL must use HTTPS, or HTTP for `localhost`, `127.0.0.1` or `[::1]` only. The watcher rejects URLs that contain credentials, and it rejects redirects. A non-2xx response or a timeout stops the watcher. The watcher never logs response bodies, URLs or authorization values. Keep URLs and credentials out of the repository, your command history and the board. Anyone who can read the process environment may be able to read them. For custom headers, signatures, retries or another transport, use a trusted process action instead.

The watcher accepts `--root DIR`, `--interval MS` (default 2000), `--timeout MS` (default 60000) and one or more `--on TYPE` filters. Both times must be between 100 and 86400000 milliseconds. Without a filter, the watcher delivers every type. `--help` lists the options. A batch looks like this:

```json
{"schema":1,"at":"2026-01-01T12:00:00.000Z","events":[{"type":"question.opened","id":"AB-0123456789AB","questionId":"TH-0123456789AB"}]}
```

The event types are `card.created`, `card.updated`, `card.removed`, `card.status`, `card.assignee`, `question.opened`, `question.closed`, `feature.created`, `feature.updated`, `feature.removed`, `issue.created`, `issue.updated`, `issue.removed`, `issue.status` and `board.updated`.

- Update events include `fields`, the names of the top-level fields that changed.
- Status and assignee events include `before` and `after`.
- Events never include full cards or question text.
- Archiving a card or feature produces an update event, not a removal.
- `question.opened` means a question became open on a non-archived card. `question.closed` means it stopped being open, for example because it was answered, its card was archived, or it was removed. Restoring a previously answered or archived question can open it again.
- Git checkouts and manual file edits can produce removal and creation events.
- One change can produce several event types. Use filters to avoid doing the same work twice.

At startup the watcher takes a baseline and emits nothing for the existing state. It reads each snapshot under the board lock and releases the lock before the action runs, so a large board or a short interval can delay writers. It compares content, so it sees changes even when a revision did not change. It upgrades older formats in memory only. A malformed snapshot produces a warning, and the next poll compares against the last good snapshot. A newer, unsupported format stops the watcher.

Actions run one at a time, and the next poll starts only after the action finishes. The watcher stops when:

- an action fails or times out;
- you press Ctrl+C, which also ends a running process action;
- a batch is larger than 1 MiB, or more than 60 action batches run in one minute. This limits accidental loops.

An action that edits the board can trigger itself, so filter events and make actions idempotent.

The watcher polls snapshots and keeps no durable event log. Several edits between polls, or during an action, can merge into one change or cancel out. The watcher does not replay changes made while it was stopped. It does not retry a failed or interrupted action, and that action may already have taken effect, so delivery is not guaranteed. Separate watchers run independently and can repeat each other's actions. Direct browser writes and Git operations do not take the CLI lock, so a poll may see them half done. If the watcher crashes or is killed, a process action may keep running. A watcher that is waiting for a held board lock cannot handle Ctrl+C until the lock is released. If the lock holder is stuck, you may need to end the watcher process from outside.

T3 Code's [webhook automations](https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md#webhook-automations) accept JSON requests. Create a webhook task whose prompt treats `{{body}}` as untrusted data, pass its URL in `AGENTBOARD_WEBHOOK_URL`, and turn on the authentication your deployment needs. AgentBoard's built-in webhook does not sign requests, so a task that requires signatures needs a custom process action. A local T3 webhook task has been tested end to end with a `card.updated` event from this repository's vendored watcher. Public T3 Connect delivery and signatures have not been tested. Through the process interface you can also write adapters for other agent harnesses or notification tools. Tests cover the local process path and a local HTTP receiver.

## Supported environments and limitations

AgentBoard is verified on Windows 11 with Bun and Chrome. The POSIX lock has not been verified on Linux or macOS yet. Desktop Chromium supports the optional direct folder mode. Use the local bridge when the CLI and UI write to the same board, because direct mode cannot share the CLI lock and concurrent writes can be lost.

Cards, comments and feature descriptions are ordinary JSON files in Git. Anyone with access to the repository can read them and their history. Keep credentials and private conversations off the board.

## License

[MIT](LICENSE), copyright Gaston Lhoest. Keep the copyright and permission notice when you redistribute the software, including vendored copies.
