// bb-plugin-worktree — backend entry.
//
// Creates a git worktree without prompting the user for anything.
//
// How it works, and why it looks odd:
//
// BB has no API that creates an environment on its own. Worktrees are only
// ever provisioned as a side effect of creating a thread, and thread creation
// requires at least one input entry (`input must contain at least one entry`).
//
// But an input entry whose text is EMPTY passes that check and then fails
// later, inside `thread.start`, with "Missing input text" — after the
// environment has been fully provisioned and before the provider is ever
// contacted. So an empty-text thread gives us a real managed worktree for
// zero tokens and zero prompts.
//
// The resulting thread sits in `error` status until it is first used. That is
// cosmetic: sending any real message clears it. The frontend relabels the
// sidebar row so the user never sees a scary state for a healthy worktree.
//
// The thread is load-bearing and must not be deleted: deleting it takes the
// environment to `destroyed` and removes the worktree from git. That is why
// "Remove" is a confirmed, destructive action rather than a tidy-up.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** How long to wait for BB to provision the worktree before giving up. */
const PROVISION_TIMEOUT_MS = 120_000;
const PROVISION_POLL_MS = 400;
/** Per-side cap on the branch picker; search narrows past it. */
const BRANCH_LIST_LIMIT = 50;

const worktreeSchema = z.object({
  threadId: z.string(),
  environmentId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  title: z.string(),
  /** Absolute path on the host, or null while BB is still settling. */
  path: z.string().nullable(),
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
  /** True once the thread has been talked to, i.e. it is a normal thread now. */
  inUse: z.boolean(),
  createdAt: z.number(),
});

export const rpcContract = defineRpcContract({
  listProjects: {
    input: z.null(),
    output: z.object({
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  },
  listWorktrees: {
    input: z.object({ projectId: z.string().optional() }).strict(),
    output: z.object({ worktrees: z.array(worktreeSchema) }),
  },
  listBranches: {
    input: z
      .object({ projectId: z.string(), query: z.string().optional() })
      .strict(),
    output: z.object({
      /** Branches that exist in the project's own checkout. */
      local: z.array(z.string()),
      /** Remote-tracking branches, already prefixed (`origin/main`). */
      remote: z.array(z.string()),
      /** What a worktree branches from when no base is chosen. */
      defaultBase: z.string().nullable(),
      /** True when the result was capped and search would narrow it. */
      truncated: z.boolean(),
    }),
  },
  createWorktree: {
    input: z
      .object({
        projectId: z.string(),
        baseBranch: z.string().optional(),
        openTerminal: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ worktree: worktreeSchema }),
  },
  openTerminal: {
    input: z.object({ environmentId: z.string() }).strict(),
    output: z.object({ terminalId: z.string() }),
  },
  openInEditor: {
    input: z.object({ environmentId: z.string() }).strict(),
    output: z.object({ terminalId: z.string(), command: z.string() }),
  },
  removeWorktree: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    openTerminalOnCreate: {
      type: "boolean",
      label: "Open a terminal in new worktrees",
      default: true,
    },
    editorCommand: {
      type: "string",
      label: "Editor command",
      default: "cursor",
    },
    titlePrefix: {
      type: "string",
      label: "Worktree name prefix",
      default: "wt",
    },
  });

  /**
   * BB derives the branch from the thread title, so the title is the only
   * naming control we have. Keep it short, unique and filesystem-safe.
   */
  function nextTitle(prefix: string, existing: ReadonlySet<string>): string {
    const base = prefix.trim().replace(/[^a-zA-Z0-9-_]/g, "-") || "wt";
    for (let n = 1; ; n += 1) {
      const candidate = `${base}-${n}`;
      if (!existing.has(candidate)) return candidate;
    }
  }

  async function resolveHostId(projectId: string): Promise<string> {
    const project = await bb.sdk.projects.get({ projectId });
    const source =
      project.sources.find((entry) => entry.isDefault) ?? project.sources[0];
    if (source) return source.hostId;

    const hosts = await bb.sdk.hosts.list();
    const connected = hosts.find((host) => host.status === "connected");
    if (!connected) {
      throw new Error(
        `Project "${project.name}" has no source checkout on a connected machine.`,
      );
    }
    return connected.id;
  }

  /**
   * A worktree thread is one this plugin spawned. `threads.spawn` stamps
   * `originPluginId` automatically, so BB's own thread list is the registry —
   * there is no separate bookkeeping to drift out of sync.
   */
  async function readWorktrees(projectId?: string) {
    const threads = await bb.sdk.threads.list({
      projectId,
      originPluginId: bb.pluginId,
      archived: false,
      limit: 200,
    });

    const projects = await bb.sdk.projects.list();
    const projectNames = new Map(projects.map((p) => [p.id, p.name]));

    const rows = await Promise.all(
      threads.map(async (thread) => {
        if (!thread.environmentId) return null;
        let environment;
        try {
          environment = await bb.sdk.environments.get({
            environmentId: thread.environmentId,
          });
        } catch {
          return null;
        }
        if (environment.status === "destroyed") return null;

        return {
          threadId: thread.id,
          environmentId: environment.id,
          projectId: thread.projectId,
          projectName: projectNames.get(thread.projectId) ?? "Unknown project",
          title: thread.title ?? thread.titleFallback ?? "Worktree",
          path: environment.path,
          branch: environment.branchName,
          baseBranch: environment.baseBranch ?? environment.defaultBranch,
          // `error` is the untouched empty-input state. Anything else means
          // the thread has been used for real work.
          inUse: thread.status !== "error",
          createdAt: thread.createdAt,
        };
      }),
    );

    return rows
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async function createWorktree(input: {
    projectId: string;
    baseBranch?: string;
    openTerminal?: boolean;
  }) {
    const { titlePrefix, openTerminalOnCreate } = await settings.get();
    const hostId = await resolveHostId(input.projectId);

    const existing = await readWorktrees(input.projectId);
    const title = nextTitle(
      titlePrefix,
      new Set(existing.map((row) => row.title)),
    );

    const thread = await bb.sdk.threads.spawn({
      projectId: input.projectId,
      title,
      environment: {
        type: "host",
        hostId,
        workspace: {
          type: "managed-worktree",
          baseBranch: input.baseBranch
            ? { kind: "named", name: input.baseBranch }
            : { kind: "default" },
        },
      },
      // Deliberately empty: provisions the worktree, never reaches a provider.
      input: [{ type: "text", text: "", mentions: [] }],
    });

    const environment = await waitForEnvironment(thread.id);

    const shouldOpenTerminal = input.openTerminal ?? openTerminalOnCreate;
    if (shouldOpenTerminal) {
      try {
        await openTerminal(environment.id);
      } catch (error) {
        // A worktree without a terminal is still a successful worktree.
        bb.log.warn(
          `Created worktree ${title} but could not open a terminal: ${String(error)}`,
        );
      }
    }

    const projects = await bb.sdk.projects.list();
    return {
      threadId: thread.id,
      environmentId: environment.id,
      projectId: input.projectId,
      projectName:
        projects.find((p) => p.id === input.projectId)?.name ?? "Unknown project",
      title,
      path: environment.path,
      branch: environment.branchName,
      baseBranch: environment.baseBranch ?? environment.defaultBranch,
      inUse: false,
      createdAt: thread.createdAt,
    };
  }

  /**
   * The spawn call returns as soon as the row exists; provisioning is async.
   * Poll until the environment is attached and ready.
   */
  async function waitForEnvironment(threadId: string) {
    const deadline = Date.now() + PROVISION_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.environmentId) {
        const environment = await bb.sdk.environments.get({
          environmentId: thread.environmentId,
        });
        if (environment.status === "ready") return environment;
        if (environment.status === "error") {
          throw new Error(
            "BB could not provision the worktree. Check the project's git checkout.",
          );
        }
      }
      await sleep(PROVISION_POLL_MS);
    }

    throw new Error("Timed out waiting for BB to provision the worktree.");
  }

  async function openTerminal(environmentId: string) {
    const terminal = await bb.sdk.terminals.create({
      scope: { kind: "environment", environmentId },
      title: "Worktree",
      cols: 120,
      rows: 32,
    });
    return terminal.id;
  }

  bb.rpc.register(rpcContract, {
    async listProjects() {
      const projects = await bb.sdk.projects.list();
      return {
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
        })),
      };
    },

    async listWorktrees({ projectId }) {
      return { worktrees: await readWorktrees(projectId) };
    },

    async listBranches({ projectId, query }) {
      const hostId = await resolveHostId(projectId);
      const result = await bb.sdk.projects.branches({
        projectId,
        hostId,
        query,
        // The query schema types this as a string.
        limit: String(BRANCH_LIST_LIMIT),
      });

      return {
        local: result.branches,
        remote: result.remoteBranches,
        defaultBase:
          result.defaultWorktreeBaseBranch ??
          result.originDefaultBranch ??
          result.defaultBranch,
        truncated: result.branchesTruncated || result.remoteBranchesTruncated,
      };
    },

    async createWorktree(input) {
      return { worktree: await createWorktree(input) };
    },

    async openTerminal({ environmentId }) {
      return { terminalId: await openTerminal(environmentId) };
    },

    async openInEditor({ environmentId }) {
      const { editorCommand } = await settings.get();
      const environment = await bb.sdk.environments.get({ environmentId });
      if (!environment.path) {
        throw new Error("This worktree has no path on disk yet.");
      }

      const command = `${editorCommand} ${quoteForShell(environment.path)}`;
      const terminal = await bb.sdk.terminals.create({
        scope: { kind: "environment", environmentId },
        title: `Open in ${editorCommand}`,
        cols: 80,
        rows: 8,
        start: { mode: "command", command },
      });
      return { terminalId: terminal.id, command };
    },

    async removeWorktree({ threadId }) {
      // Deleting the thread is what destroys the worktree; there is no
      // separate environment delete. The frontend confirms before calling.
      await bb.sdk.threads.delete({ threadId, childThreadsConfirmed: true });
      return { ok: true };
    },
  });

  bb.cli.register({
    name: "worktree",
    summary: "Create and manage git worktrees without leaving BB",
    commands: [
      {
        name: "new",
        summary:
          "Create a worktree and print its path (no prompt, no agent turn)",
        usage: "bb worktree new [--project <id>] [--base <branch>] [--no-terminal]",
      },
      {
        name: "list",
        summary: "List worktrees this plugin created",
        usage: "bb worktree list [--project <id>]",
      },
      {
        name: "rm",
        summary: "Delete a worktree and its thread permanently",
        usage: "bb worktree rm <thread-id>",
      },
    ],
    async run(argv, ctx) {
      const [subcommand, ...rest] = argv;
      const flags = parseFlags(rest);

      try {
        switch (subcommand) {
          case "new": {
            const projectId = flagString(flags.project) ?? ctx.projectId;
            if (!projectId) {
              return {
                exitCode: 1,
                stderr: "No project. Pass --project <id>.",
              };
            }
            const worktree = await createWorktree({
              projectId,
              baseBranch: flagString(flags.base),
              openTerminal: !flags["no-terminal"],
            });
            return {
              exitCode: 0,
              stdout: `${worktree.path ?? "(path pending)"}\n`,
            };
          }

          case "list": {
            const worktrees = await readWorktrees(
              flagString(flags.project) ?? ctx.projectId,
            );
            if (worktrees.length === 0) {
              return { exitCode: 0, stdout: "No worktrees.\n" };
            }
            const lines = worktrees.map(
              (row) =>
                `${row.threadId}  ${row.branch ?? "-"}  ${row.path ?? "-"}`,
            );
            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
          }

          case "rm": {
            const threadId = rest[0];
            if (!threadId) {
              return { exitCode: 1, stderr: "Usage: bb worktree rm <thread-id>\n" };
            }
            await bb.sdk.threads.delete({
              threadId,
              childThreadsConfirmed: true,
            });
            return { exitCode: 0, stdout: `Removed ${threadId}.\n` };
          }

          default:
            return {
              exitCode: 1,
              stderr: "Usage: bb worktree <new|list|rm>\n",
            };
        }
      } catch (error) {
        return {
          exitCode: 1,
          stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        };
      }
    },
  });
}

/** Flags parsed as bare booleans are not usable where a value is required. */
function flagString(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function parseFlags(argv: readonly string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}
