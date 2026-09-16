import { createHmac, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { tool } from "ai";
import type { Session } from "next-auth";
import { z } from "zod";
import { logger } from "@/lib/logger";

const WORKSPACE_ACCOUNT = (
  process.env.CHATBOT_WORKSPACE_ACCOUNT ?? "blechdom@gmail.com"
)
  .trim()
  .toLowerCase();
const WORKSPACE_AUDIENCE = "workspace-blechdom";
const WORKSPACE_SECRET_FILE =
  process.env.CHATBOT_WORKSPACE_SECRET_FILE ??
  "/run/secrets/blechdom-workspace-token";
const WORKSPACE_URL =
  process.env.CHATBOT_WORKSPACE_URL ??
  "http://chatbot-workspace-blechdom:8080/mcp";

type WorkspaceToolName =
  | "git_auth_status"
  | "git_clone"
  | "git_commit"
  | "git_create_branch"
  | "git_diff"
  | "git_fetch"
  | "git_log"
  | "git_pull"
  | "git_push"
  | "git_remote_check"
  | "git_repo_info"
  | "git_set_identity"
  | "git_stage"
  | "git_status"
  | "workspace_apply_patch"
  | "workspace_list"
  | "workspace_propose_patch"
  | "workspace_read";

type McpEnvelope = {
  error?: { code?: number; message?: string };
  result?: {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
};

export function hasWorkspaceAccess(session: Session) {
  return (
    process.env.CHATBOT_WORKSPACE_ENABLED === "true" &&
    session.user.email?.trim().toLowerCase() === WORKSPACE_ACCOUNT
  );
}

async function workspaceSecret() {
  const info = await stat(WORKSPACE_SECRET_FILE);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size < 32) {
    throw new Error("Workspace service credential is unavailable");
  }
  return (await readFile(WORKSPACE_SECRET_FILE)).toString("utf8").trim();
}

async function authorization(session: Session) {
  if (!hasWorkspaceAccess(session) || !session.user.email) {
    throw new Error("This account has no workspace access");
  }
  const payload = Buffer.from(
    JSON.stringify({
      aud: WORKSPACE_AUDIENCE,
      email: session.user.email.trim().toLowerCase(),
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: "nv-chat",
      sub: session.user.id,
    })
  ).toString("base64url");
  const signature = createHmac("sha256", await workspaceSecret())
    .update(payload)
    .digest("base64url");
  return `Bearer ${payload}.${signature}`;
}

async function callWorkspace(
  session: Session,
  name: WorkspaceToolName,
  args: Record<string, string>
) {
  const startedAt = Date.now();
  logger.info("workspace.tool.start", {
    tool: name,
    userId: session.user.id,
  });

  try {
    const response = await fetch(WORKSPACE_URL, {
      body: JSON.stringify({
        id: randomUUID(),
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: args, name },
      }),
      headers: {
        Authorization: await authorization(session),
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      method: "POST",
      signal: AbortSignal.timeout(name.startsWith("git_") ? 330_000 : 20_000),
    });
    const envelope = (await response.json()) as McpEnvelope;
    const result = envelope.result?.structuredContent;
    const ok = response.ok && !envelope.error && !envelope.result?.isError;
    logger.info("workspace.tool.complete", {
      durationMs: Date.now() - startedAt,
      ok,
      status: response.status,
      tool: name,
      userId: session.user.id,
    });
    if (result) {
      return result;
    }
    return {
      error: envelope.error?.message ?? "Workspace service request failed",
      ok: false,
    };
  } catch (error) {
    logger.error("workspace.tool.error", {
      durationMs: Date.now() - startedAt,
      error,
      tool: name,
      userId: session.user.id,
    });
    return { error: "Workspace service is unavailable", ok: false };
  }
}

export function createWorkspaceTools(session: Session) {
  return {
    gitAuthStatus: tool({
      description:
        "Report whether GitHub and NVIDIA GitLab credentials are available to the isolated workspace. Never returns credentials.",
      execute: () => callWorkspace(session, "git_auth_status", {}),
      inputSchema: z.object({}),
    }),
    gitClone: tool({
      description:
        "Clone an assigned GitHub or NVIDIA GitLab repository into creative/ or nvidia/. Use a relative destination such as creative/project-name.",
      execute: ({ destination, repository }) =>
        callWorkspace(session, "git_clone", { destination, repository }),
      inputSchema: z.object({
        destination: z.string().min(1).max(512),
        repository: z.string().min(1).max(1024),
      }),
    }),
    gitCommit: tool({
      description:
        "Commit the currently staged changes in an assigned repository. Review gitDiff with staged=true before committing.",
      execute: ({ message, repo }) =>
        callWorkspace(session, "git_commit", { message, repo }),
      inputSchema: z.object({
        message: z.string().min(1).max(2000),
        repo: z.string().min(1).max(512),
      }),
    }),
    gitCreateBranch: tool({
      description:
        "Create and switch to a new branch in an assigned repository.",
      execute: ({ branch, repo }) =>
        callWorkspace(session, "git_create_branch", { branch, repo }),
      inputSchema: z.object({
        branch: z.string().min(1).max(128),
        repo: z.string().min(1).max(512),
      }),
    }),
    gitDiff: tool({
      description:
        "Show the working-tree or staged patch for an assigned repository.",
      execute: ({ repo, staged }) =>
        callWorkspace(session, "git_diff", {
          repo,
          staged: staged ? "true" : "false",
        }),
      inputSchema: z.object({
        repo: z.string().min(1).max(512),
        staged: z.boolean().optional().default(false),
      }),
    }),
    gitFetch: tool({
      description:
        "Fetch and prune origin branches from an assigned GitHub or NVIDIA GitLab repository without changing the working tree.",
      execute: ({ repo }) => callWorkspace(session, "git_fetch", { repo }),
      inputSchema: z.object({ repo: z.string().min(1).max(512) }),
    }),
    gitLog: tool({
      description: "Show the 12 most recent commits in an assigned repository.",
      execute: ({ repo }) => callWorkspace(session, "git_log", { repo }),
      inputSchema: z.object({ repo: z.string().min(1).max(512) }),
    }),
    gitPull: tool({
      description:
        "Fetch the checked-out branch and update it only when a fast-forward is possible.",
      execute: ({ repo }) => callWorkspace(session, "git_pull", { repo }),
      inputSchema: z.object({ repo: z.string().min(1).max(512) }),
    }),
    gitPush: tool({
      description:
        "Push the current branch to origin. This writes to GitHub or NVIDIA GitLab and always requires user approval.",
      execute: ({ repo }) => callWorkspace(session, "git_push", { repo }),
      inputSchema: z.object({ repo: z.string().min(1).max(512) }),
      needsApproval: true,
    }),
    gitRemoteCheck: tool({
      description:
        "Verify that the assigned repository remote and its GitHub or NVIDIA GitLab credentials work without changing local files or remote state.",
      execute: ({ repo }) =>
        callWorkspace(session, "git_remote_check", { repo }),
      inputSchema: z.object({ repo: z.string().min(1).max(512) }),
    }),
    gitRepoInfo: tool({
      description:
        "Show the current branch, safe canonical remote, forge, and commit identity for an assigned repository.",
      execute: ({ repo }) => callWorkspace(session, "git_repo_info", { repo }),
      inputSchema: z.object({ repo: z.string().min(1).max(512) }),
    }),
    gitSetIdentity: tool({
      description:
        "Set repository-local Git author name and email. This does not change the host's global Git configuration.",
      execute: ({ email, name, repo }) =>
        callWorkspace(session, "git_set_identity", { email, name, repo }),
      inputSchema: z.object({
        email: z.string().email().max(254),
        name: z.string().min(1).max(128),
        repo: z.string().min(1).max(512),
      }),
    }),
    gitStage: tool({
      description:
        "Stage one file or directory path in an assigned repository. Review gitStatus and gitDiff first.",
      execute: ({ path, repo }) =>
        callWorkspace(session, "git_stage", { path, repo }),
      inputSchema: z.object({
        path: z.string().min(1).max(512),
        repo: z.string().min(1).max(512),
      }),
    }),
    gitStatus: tool({
      description:
        "Show branch and complete short status for an assigned repository.",
      execute: ({ repo }) => callWorkspace(session, "git_status", { repo }),
      inputSchema: z.object({ repo: z.string().min(1).max(512) }),
    }),
    workspaceApplyPatch: tool({
      description:
        "Apply a previously proposed workspace patch after the user reviews and approves it.",
      execute: ({ proposalId }) =>
        callWorkspace(session, "workspace_apply_patch", { proposalId }),
      inputSchema: z.object({ proposalId: z.string().uuid() }),
      needsApproval: true,
    }),
    workspaceList: tool({
      description:
        "List files in the assigned workspace. The relative roots creative/ and nvidia/ map to /home/blechdom/creative and /home/blechdom/nvidia.",
      execute: ({ path }) => callWorkspace(session, "workspace_list", { path }),
      inputSchema: z.object({
        path: z.string().max(512).optional().default("."),
      }),
    }),
    workspaceProposePatch: tool({
      description:
        "Prepare a complete UTF-8 replacement for a workspace file and return its diff. Call workspaceApplyPatch with the proposal ID only after reviewing the diff.",
      execute: ({ content, path }) =>
        callWorkspace(session, "workspace_propose_patch", { content, path }),
      inputSchema: z.object({
        content: z.string().max(262_144),
        path: z.string().min(1).max(512),
      }),
    }),
    workspaceRead: tool({
      description:
        "Read a UTF-8 file from the assigned creative/ or nvidia/ workspace roots.",
      execute: ({ path }) => callWorkspace(session, "workspace_read", { path }),
      inputSchema: z.object({ path: z.string().min(1).max(512) }),
    }),
  };
}
