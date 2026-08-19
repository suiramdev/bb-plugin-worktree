# Worktree

Create a git worktree in [BB](https://getbb.app) without being prompted for
anything, and get a terminal running in it.

Sometimes you just want a worktree. Not a thread, not a prompt, not an agent
turn — a checkout on a fresh branch and a shell sitting in it. BB normally only
creates worktrees as a side effect of starting a thread, which means going
through the composer and saying something to an agent first. This plugin
removes that step.

```
Click "New worktree"  →  ~/.bb/worktrees/env_2u2qrnje6e/my-repo   (~7s)
                         branch: bb/wt-1-thr_yge4zwwydm
                         terminal: running, cwd set
```

## Install

```sh
bb plugin install https://github.com/suiramdev/bb-plugin-worktree
```

## Use it

**From the New Thread page.** Below the prompt box, under a divider reading
*or start without a prompt*, sits a `New worktree` button. One click creates the
worktree from the project's default base and opens a terminal in it — no prompt,
no agent turn.

```
┌──────────────────────────────────────────┐
│  What are we working on?                 │
└──────────────────────────────────────────┘

──────── or start without a prompt ────────

        Project [ my-repo ▾ ]  [ ⎇ New worktree │ ▾ ]
```

**From another branch.** The chevron opens a searchable branch picker listing
local and remote branches together. Search runs server-side over the whole set,
so it is not limited to the first page. Picking a branch creates the worktree
from it; the plain click still needs no input at all.

Below the control, the same section lists the worktrees you have, with per-row
actions to open a terminal, open your editor, copy the path, or delete it.

**From a terminal or an agent.**

```sh
bb worktree new [--project <id>] [--base <branch>] [--no-terminal]
bb worktree list [--project <id>]
bb worktree rm <thread-id>
```

`bb worktree new` prints the absolute path on stdout, so it composes:

```sh
cd "$(bb worktree new)"
```

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Open a terminal in new worktrees | on | Starts a shell in the worktree as soon as it exists |
| Editor command | `cursor` | Command the "Open in your editor" action runs |
| Worktree name prefix | `wt` | Names become `wt-1`, `wt-2`, … and drive the branch name |

Settings changes need `bb plugin reload worktree` to take effect.

## How it works

BB has no API for creating an environment on its own. Worktrees are only ever
provisioned as a side effect of creating a thread, and thread creation rejects
an empty input array:

```
POST /api/v1/threads  {"input": []}
→ {"code":"invalid_request","message":"input must contain at least one entry"}
```

But an input entry whose *text* is empty passes that check and then fails later,
inside `thread.start`:

```
events: turn/requested → thread/start → provisioning ×5 → system/error
system/error: {"code":"thread_command_failed","detail":"Missing input text"}
```

That failure happens **after** the environment is fully provisioned and
**before** the provider is ever contacted. So an empty-text thread buys a real
managed worktree for zero tokens and zero prompts.

Two consequences worth knowing about:

**The thread stays in `error` until you use it.** This is cosmetic — sending any
real message clears it. The plugin relabels those sidebar rows so a healthy
worktree doesn't wear a failure glyph while it waits.

**Don't delete the thread by hand.** The worktree's lifetime is bound to it:
deleting the thread takes the environment to `destroyed` and drops the worktree
from `git worktree list`, uncommitted changes included. That's why `Delete
worktree` asks first. It's also why the thread is the registry — BB's own thread
list is the source of truth, so there's no separate bookkeeping to drift.

If BB ever grows a real environment-creation API, the empty-input trick becomes
one function call to replace.

## Requirements

BB `>=0.39`. No external dependencies — everything runs through the BB SDK.

## License

MIT
