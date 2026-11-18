// Agent loop: permission modes, tool risk levels, SSE / polling event shapes.
import type { LlmErrorInfo, Message, Part, StreamEvent } from "./llm";

export const RISK_LEVELS = ["read", "write", "dangerous", "external"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const RISK_LABELS: Record<RiskLevel, string> = { read: "讀取", write: "寫入", dangerous: "危險", external: "外部副作用" };

export const PERMISSION_MODES = ["plan", "normal", "auto_edit", "full", "custom"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  plan: "唯讀（Plan）",
  normal: "一般",
  auto_edit: "自動編輯",
  full: "全部權限",
  custom: "自訂",
};

export type PolicyAction = "allow" | "ask" | "deny";
export type PolicyScope = "global" | "project" | "conversation";

/** Optional rule on a tool policy. A rule-bearing policy only applies when every target matches. */
export interface PolicyRule {
  /** e.g. "docs/**" or ["docs/**", "*.md"] */
  pathGlob?: string | string[];
  /** e.g. ["api.example.com", "*.github.com"] */
  domains?: string[];
}

export type ApprovalDecision = "allow_once" | "allow_conversation" | "deny";

export type RunStatus = "pending" | "running" | "paused" | "waiting_approval" | "stopping" | "completed" | "failed" | "stopped";
export const TERMINAL_RUN_STATUSES: RunStatus[] = ["completed", "failed", "stopped"];

export interface PendingApprovalDTO {
  id: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  risk: RiskLevel | "unknown";
  reason: string;
  /** "question" = ask_user (answer instead of allow/deny); "client" = client-side tool (code_run python in the browser), the web app executes it and POSTs /runs/:id/client-results. Default "approval". */
  kind?: "approval" | "question" | "client";
}

export interface StoredMessageDTO {
  id: string;
  parentId: string | null;
  role: Message["role"];
  parts: Part[];
  runId: string | null;
  createdAt: string;
}

/** Events on the /api/chat SSE stream (and mirrored, at step granularity, by run_steps polling). */
export type AgentEvent =
  | { type: "run"; runId: string; conversationId: string; userMessageId: string | null; status: RunStatus }
  | Exclude<StreamEvent, { type: "finish" } | { type: "error" }>
  | { type: "message"; message: StoredMessageDTO }
  | { type: "tool-result"; callId: string; name: string; result: unknown; isError?: boolean }
  | { type: "approval-required"; approvals: PendingApprovalDTO[] }
  /** Segment budget reached: re-POST /api/chat { runId, action: "continue" } to resume seamlessly. */
  | { type: "continue"; runId: string; /** the run moved to background mode: the next POST answers 202 */ mode?: "background" }
  | { type: "done"; status: RunStatus; reason?: string }
  | { type: "error"; error: LlmErrorInfo };
