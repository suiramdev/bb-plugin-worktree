// bb-plugin-worktree — frontend entry.
//
// Three surfaces:
//   1. A "New worktree" action inside the new-thread composer.
//   2. A "Worktrees" homepage section listing and managing them.
//   3. A content script that relabels the sidebar row for worktree threads,
//      so the harmless `error` status they carry until first use never reads
//      as a broken thread.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  useComposerView,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { CONTROL_HOVER_TRANSITION } from "@/components/ui/motion";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

interface WorktreeRow {
  threadId: string;
  environmentId: string;
  projectId: string;
  projectName: string;
  title: string;
  path: string | null;
  branch: string | null;
  baseBranch: string | null;
  inUse: boolean;
  createdAt: number;
}

interface ProjectOption {
  id: string;
  name: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Shared create action. Returns the new row so callers can react, and reports
 * success and failure through the host toaster either way.
 */
function useCreateWorktree(rpc: Rpc) {
  const [isCreating, setIsCreating] = useState(false);

  const create = useCallback(
    async (projectId: string): Promise<WorktreeRow | null> => {
      setIsCreating(true);
      try {
        const { worktree } = await rpc.call("createWorktree", { projectId });
        toast.success(`Worktree ${worktree.title} is ready`, {
          description: worktree.branch ?? undefined,
        });
        return worktree as WorktreeRow;
      } catch (error) {
        toast.error("Could not create the worktree", {
          description: errorMessage(error),
        });
        return null;
      } finally {
        setIsCreating(false);
      }
    },
    [rpc],
  );

  return { create, isCreating };
}

/**
 * Composer action. Renders one 28px-safe inline control, per the host's
 * action-row contract.
 */
function ComposerCreateAction() {
  const rpc = useRpc<typeof rpcContract>();
  const view = useComposerView();
  const { create, isCreating } = useCreateWorktree(rpc);

  const projectId =
    view.scope.kind === "new-thread" ? view.scope.projectId : null;

  // Without a project there is no repository to branch from, so the control is
  // disabled rather than hidden: a control that appears and disappears while
  // you change the project picker is harder to find than one that waits.
  const isDisabled = projectId === null || isCreating;

  const hint =
    projectId === null
      ? "Choose a project to create a worktree"
      : "Create a worktree and open a terminal in it";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A disabled button is not hoverable, so the wrapper keeps the
              tooltip reachable in the state where the hint matters most. */}
          <span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={isDisabled}
              aria-label="New worktree"
              aria-describedby={undefined}
              className={CONTROL_HOVER_TRANSITION}
              onClick={() => {
                if (projectId === null) return;
                void create(projectId);
              }}
            >
              <Icon
                name={isCreating ? "Loading" : "GitBranch"}
                aria-hidden="true"
                className={
                  isCreating ? "size-4 motion-safe:animate-spin" : "size-4"
                }
              />
              <span className="ml-1.5">
                {isCreating ? "Creating…" : "New worktree"}
              </span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** One worktree in the homepage list. */
/**
 * Icon-only row control. The visible label lives in a tooltip and the
 * accessible name on the button, so pointer and assistive-technology users get
 * the same information without the button rendering visible text.
 */
function IconAction({
  icon,
  label,
  hint,
  disabled,
  onClick,
}: {
  icon: "Terminal" | "Code" | "Copy" | "Trash2";
  label: string;
  hint: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={disabled}
            aria-label={label}
            className={CONTROL_HOVER_TRANSITION}
            onClick={onClick}
          >
            <Icon name={icon} aria-hidden="true" className="size-4" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}
function WorktreeListRow({
  row,
  rpc,
  onChanged,
}: {
  row: WorktreeRow;
  rpc: Rpc;
  onChanged: () => void;
}) {
  const [pendingRemoval, setPendingRemoval] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);

  const run = useCallback(
    async (
      label: string,
      action: () => Promise<unknown>,
      successMessage: string,
    ) => {
      try {
        await action();
        toast.success(successMessage);
      } catch (error) {
        toast.error(label, { description: errorMessage(error) });
      }
    },
    [],
  );

  return (
    <li className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
      <Icon
        name="GitBranch"
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground"
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{row.title}</span>
          {/* Status is carried by text, not by color alone. */}
          <span className="shrink-0 text-xs text-muted-foreground">
            {row.inUse ? "In use" : "Unused"}
          </span>
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {row.branch ?? row.path ?? "Preparing…"}
        </p>
      </div>

      <TooltipProvider>
        <div className="flex shrink-0 items-center gap-1">
          <IconAction
            icon="Terminal"
            label={`Open a terminal in ${row.title}`}
            hint="Open a terminal"
            onClick={() =>
              void run(
                "Could not open a terminal",
                () =>
                  rpc.call("openTerminal", {
                    environmentId: row.environmentId,
                  }),
                `Terminal opened in ${row.title}`,
              )
            }
          />

          <IconAction
            icon="Code"
            label={`Open ${row.title} in your editor`}
            hint="Open in your editor"
            onClick={() =>
              void run(
                "Could not open your editor",
                () =>
                  rpc.call("openInEditor", {
                    environmentId: row.environmentId,
                  }),
                `Opening ${row.title}`,
              )
            }
          />

          <IconAction
            icon="Copy"
            label={`Copy the path to ${row.title}`}
            hint="Copy path"
            disabled={row.path === null}
            onClick={() => {
              if (!row.path) return;
              void navigator.clipboard.writeText(row.path).then(
                () => toast.success("Path copied"),
                () => toast.error("Could not copy the path"),
              );
            }}
          />

          <IconAction
            icon="Trash2"
            label={`Delete ${row.title}`}
            hint="Delete worktree"
            onClick={() => setPendingRemoval(true)}
          />
        </div>
      </TooltipProvider>

      {/* Deleting is unrecoverable: it removes the git worktree and every
          uncommitted change in it, so it is confirmed and named plainly. */}
      <Dialog open={pendingRemoval} onOpenChange={setPendingRemoval}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {row.title}?</DialogTitle>
            <DialogDescription>
              This removes the worktree from git and deletes its thread. Any
              uncommitted work in{" "}
              <span className="font-mono">{row.branch ?? "this branch"}</span>{" "}
              is lost. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingRemoval(false)}
            >
              Keep it
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isRemoving}
              onClick={() => {
                setIsRemoving(true);
                void rpc
                  .call("removeWorktree", { threadId: row.threadId })
                  .then(
                    () => {
                      toast.success(`Deleted ${row.title}`);
                      setPendingRemoval(false);
                      onChanged();
                    },
                    (error: unknown) =>
                      toast.error("Could not delete the worktree", {
                        description: errorMessage(error),
                      }),
                  )
                  .finally(() => setIsRemoving(false));
              }}
            >
              {isRemoving ? "Deleting…" : "Delete worktree"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

/** The homepage "Worktrees" section. */
function WorktreesSection({ projectId }: { projectId: string | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const { create, isCreating } = useCreateWorktree(rpc);

  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [rows, setRows] = useState<WorktreeRow[] | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    projectId,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const selectId = useRef(
    `worktree-project-${Math.random().toString(36).slice(2)}`,
  ).current;

  useEffect(() => {
    let cancelled = false;
    void rpc.call("listProjects", null).then(
      (result) => {
        if (cancelled) return;
        setProjects(result.projects);
        setSelectedProjectId((current) => current ?? result.projects[0]?.id ?? null);
      },
      () => {
        /* The list below reports the failure; a second toast would be noise. */
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  // Follow the host's project selection when it changes.
  useEffect(() => {
    if (projectId) setSelectedProjectId(projectId);
  }, [projectId]);

  const refresh = useCallback(() => {
    let cancelled = false;
    void rpc
      .call("listWorktrees", selectedProjectId ? { projectId: selectedProjectId } : {})
      .then(
        (result) => {
          if (cancelled) return;
          setRows(result.worktrees as WorktreeRow[]);
          setLoadError(null);
        },
        (error: unknown) => {
          if (cancelled) return;
          setRows([]);
          setLoadError(errorMessage(error));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [rpc, selectedProjectId]);

  useEffect(() => refresh(), [refresh]);

  const selectedProjectName = useMemo(
    () => projects.find((p) => p.id === selectedProjectId)?.name ?? null,
    [projects, selectedProjectId],
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <label
            htmlFor={selectId}
            className="text-xs font-medium text-muted-foreground"
          >
            Project
          </label>
          <select
            id={selectId}
            value={selectedProjectId ?? ""}
            onChange={(event) => setSelectedProjectId(event.target.value || null)}
            className="h-8 min-w-40 max-w-full rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {projects.length === 0 && <option value="">No projects</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>

        <Button
          type="button"
          size="sm"
          disabled={selectedProjectId === null || isCreating}
          className={CONTROL_HOVER_TRANSITION}
          onClick={() => {
            if (!selectedProjectId) return;
            void create(selectedProjectId).then((created) => {
              if (created) refresh();
            });
          }}
        >
          <Icon
            name={isCreating ? "Loading" : "Plus"}
            aria-hidden="true"
            className={isCreating ? "size-4 motion-safe:animate-spin" : "size-4"}
          />
          <span className="ml-1.5">
            {isCreating ? "Creating…" : "New worktree"}
          </span>
        </Button>
      </div>

      {rows === null ? (
        <p className="text-sm text-muted-foreground">Loading worktrees…</p>
      ) : loadError !== null ? (
        <p className="text-sm text-destructive">
          Could not load worktrees. {loadError}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No worktrees yet
          {selectedProjectName ? ` in ${selectedProjectName}` : ""}. Creating one
          takes a few seconds and starts a terminal in it.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <WorktreeListRow
              key={row.threadId}
              row={row}
              rpc={rpc}
              onChanged={refresh}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function HomepageSection({ projectId }: { projectId: string | null }) {
  return <WorktreesSection projectId={projectId} />;
}

export default definePluginApp((app) => {
  app.slots.homepageSection({
    id: "worktrees",
    title: "Worktrees",
    component: HomepageSection,
  });

  app.composer.customize({
    id: "worktree-composer",
    scopes: ["new-thread"],
    actions: [{ id: "new-worktree", component: ComposerCreateAction }],
  });

  // An unused worktree thread reports `error`, because the empty input that
  // provisions the worktree never reaches a provider. Relabel those rows so a
  // healthy worktree does not wear a failure glyph.
  app.contentScripts.register({
    id: "worktree-row-status",
    mount({ signal, experimental_setThreadRowStatus }) {
      if (!experimental_setThreadRowStatus) return;

      const tracked = new Set<string>();

      async function sync() {
        const response = await fetch(
          "/api/v1/plugins/worktree/rpc/listWorktrees",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
            signal,
          },
        );
        if (!response.ok) return;
        const payload = (await response.json()) as {
          ok?: boolean;
          result?: { worktrees: WorktreeRow[] };
        };
        if (!payload.ok || !payload.result) return;

        const current = new Set<string>();
        for (const row of payload.result.worktrees) {
          if (row.inUse) continue;
          current.add(row.threadId);
          experimental_setThreadRowStatus?.(row.threadId, {
            icon: "GitBranch",
            label: "Worktree, not used yet",
          });
        }
        for (const threadId of tracked) {
          if (!current.has(threadId)) {
            experimental_setThreadRowStatus?.(threadId, null);
          }
        }
        tracked.clear();
        for (const threadId of current) tracked.add(threadId);
      }

      void sync().catch(() => {
        /* Cosmetic only; a failure just leaves BB's own status in place. */
      });
      const timer = setInterval(() => {
        void sync().catch(() => {});
      }, 15_000);

      return () => {
        clearInterval(timer);
        for (const threadId of tracked) {
          experimental_setThreadRowStatus?.(threadId, null);
        }
        tracked.clear();
      };
    },
  });
});
