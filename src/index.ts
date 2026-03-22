import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { tool, type Plugin } from "@opencode-ai/plugin";

import { loadAgentConfigs } from "./agents";
import { loadCommandConfigs, installGlobalCommandFiles } from "./commands";

import { WaveStateManager } from "./wave-state";

const WAVE_NAMES = {
  1: "Interview",
  2: "Gap Analysis",
  3: "Plan Generation",
  4: "Review"
} as const;

const WAVE_NEXT_STEPS = {
  1: "stakeholder interview and context gathering",
  2: "gap analysis and risk surfacing",
  3: "writing the plan file",
  4: "plan review and refinement"
} as const;

type Todo = {
  id?: string;
  content: string;
  status: string;
  priority: string;
};

type TodoNudgeState = {
  prompted: boolean;
  retried: boolean;
  seeded: boolean;
};

type NotificationMode = "off" | "metadata" | "os" | "both";

type NotificationEvent = "need_answers" | "plan_ready" | "coding_complete";

type NotificationInput = {
  sessionID: string;
  event: NotificationEvent;
  title: string;
  message: string;
  dedupeKey: string;
  toolContext?: unknown;
};

type PluginContext = {
  manager: WaveStateManager;
  todoNudges: Map<string, TodoNudgeState>;
  notifications: NotificationManager;
  worktree: string;
  directory: string;
  client: unknown;
};

const PLUGIN_DISPLAY_NAME = "opencode-discipline";

const startupToastShownByDirectory = new Set<string>();
const startupToastInFlightByDirectory = new Set<string>();
const startupToastAttemptsByDirectory = new Map<string, number>();
const startupToastRetryTimerByDirectory = new Map<string, ReturnType<typeof setTimeout>>();
const MAX_STARTUP_TOAST_ATTEMPTS = 8;

function parseNotificationMode(raw: string | undefined): NotificationMode {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return "os";
  }

  if (value === "off" || value === "0" || value === "false" || value === "disabled") {
    return "off";
  }

  if (value === "metadata") {
    return "metadata";
  }

  if (value === "both" || value === "all") {
    return "both";
  }

  return "os";
}

function readPluginVersion(pluginDir: string): string {
  try {
    const packageJsonPath = resolve(pluginDir, "../package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      version?: unknown;
    };

    return typeof packageJson.version === "string" ? packageJson.version : "unknown";
  } catch {
    return "unknown";
  }
}

async function showStartupToast(client: unknown, directory: string, version: string): Promise<void> {
  const attempts = startupToastAttemptsByDirectory.get(directory) ?? 0;
  if (
    startupToastShownByDirectory.has(directory) ||
    startupToastInFlightByDirectory.has(directory) ||
    attempts >= MAX_STARTUP_TOAST_ATTEMPTS
  ) {
    return;
  }

  startupToastAttemptsByDirectory.set(directory, attempts + 1);

  const tuiApi = (client as { tui?: Record<string, unknown> }).tui;
  const showToast =
    tuiApi && typeof tuiApi.showToast === "function"
      ? (tuiApi.showToast as (input: Record<string, unknown>) => Promise<unknown>)
      : undefined;
  const publish =
    tuiApi && typeof tuiApi.publish === "function"
      ? (tuiApi.publish as (input: Record<string, unknown>) => Promise<unknown>)
      : undefined;

  if (!showToast && !publish) {
    return;
  }

  startupToastInFlightByDirectory.add(directory);

  try {
    const toastBody = {
      title: "Discipline Plugin",
      message: `${PLUGIN_DISPLAY_NAME} v${version} is running`,
      variant: "info",
      duration: 3000
    };

    let sent = false;

    if (showToast) {
      try {
        await showToast({
          body: toastBody
        });
        sent = true;
      } catch {
        // Fallback to publish below.
      }
    }

    if (!sent && publish) {
      await publish({
        body: {
          type: "tui.toast.show",
          properties: toastBody
        }
      });
      sent = true;
    }

    if (sent) {
      startupToastShownByDirectory.add(directory);
      const retryTimer = startupToastRetryTimerByDirectory.get(directory);
      if (retryTimer) {
        clearTimeout(retryTimer);
        startupToastRetryTimerByDirectory.delete(directory);
      }
    }
  } catch {
    // Non-fatal: plugin should work even if toast transport is unavailable.
  } finally {
    startupToastInFlightByDirectory.delete(directory);
  }
}

function scheduleStartupToastRetry(
  client: unknown,
  directory: string,
  version: string,
  delayMs = 750
): void {
  if (startupToastShownByDirectory.has(directory)) {
    return;
  }

  const attempts = startupToastAttemptsByDirectory.get(directory) ?? 0;
  if (attempts >= MAX_STARTUP_TOAST_ATTEMPTS) {
    return;
  }

  if (startupToastRetryTimerByDirectory.has(directory)) {
    return;
  }

  const timer = setTimeout(() => {
    startupToastRetryTimerByDirectory.delete(directory);
    void showStartupToast(client, directory, version).finally(() => {
      if (!startupToastShownByDirectory.has(directory)) {
        scheduleStartupToastRetry(client, directory, version, delayMs);
      }
    });
  }, delayMs);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  startupToastRetryTimerByDirectory.set(directory, timer);
}

async function handleEvent(
  ctx: PluginContext,
  input: { event?: { type?: unknown } },
  pluginVersion: string
): Promise<void> {
  if (startupToastShownByDirectory.has(ctx.directory)) {
    return;
  }

  const eventType = input.event?.type;
  if (
    eventType !== "server.connected" &&
    eventType !== "session.created" &&
    eventType !== "session.status" &&
    eventType !== "tui.command.execute"
  ) {
    return;
  }

  await showStartupToast(ctx.client, ctx.directory, pluginVersion);
  if (!startupToastShownByDirectory.has(ctx.directory)) {
    scheduleStartupToastRetry(ctx.client, ctx.directory, pluginVersion, 250);
  }
}

function escapeAppleScriptString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", " ")
    .replaceAll("\r", "");
}

function escapePowerShellString(value: string): string {
  return value.replaceAll("'", "''");
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeCmdExeValue(value: string): string {
  const escaped = value
    .replaceAll("^", "^^")
    .replaceAll("%", "%%")
    .replaceAll("!", "^^!")
    .replaceAll("&", "^&")
    .replaceAll("|", "^|")
    .replaceAll("<", "^<")
    .replaceAll(">", "^>")
    .replaceAll("(", "^(")
    .replaceAll(")", "^)")
    .replaceAll('"', '\\"');
  return `"${escaped}"`;
}

function interpolateNotificationCommand(
  template: string,
  input: NotificationInput,
  escapeValue: (value: string) => string
): string {
  return template
    .replaceAll("{event}", escapeValue(input.event))
    .replaceAll("{title}", escapeValue(input.title))
    .replaceAll("{message}", escapeValue(input.message))
    .replaceAll("{sessionID}", escapeValue(input.sessionID));
}

function buildNotificationEnv(input: NotificationInput): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DISCIPLINE_EVENT: input.event,
    DISCIPLINE_TITLE: input.title,
    DISCIPLINE_MESSAGE: input.message,
    DISCIPLINE_SESSION_ID: input.sessionID
  };
}

class NotificationManager {
  private readonly mode: NotificationMode;

  private readonly commandTemplate?: string;

  private readonly sentKeys = new Map<string, Set<string>>();

  constructor() {
    this.mode = parseNotificationMode(process.env.OPENCODE_DISCIPLINE_NOTIFY);
    this.commandTemplate = process.env.OPENCODE_DISCIPLINE_NOTIFY_COMMAND?.trim();
  }

  notify(input: NotificationInput): void {
    if (this.mode === "off") {
      return;
    }

    if (this.isSent(input.sessionID, input.dedupeKey)) {
      return;
    }

    this.markSent(input.sessionID, input.dedupeKey);

    if (this.mode === "metadata" || this.mode === "both") {
      this.emitMetadata(input);
    }

    if (this.mode === "os" || this.mode === "both") {
      this.emitOsNotification(input);
    }
  }

  private isSent(sessionID: string, key: string): boolean {
    const keys = this.sentKeys.get(sessionID);
    return keys?.has(key) ?? false;
  }

  private markSent(sessionID: string, key: string): void {
    const keys = this.sentKeys.get(sessionID) ?? new Set<string>();
    keys.add(key);
    this.sentKeys.set(sessionID, keys);
  }

  private emitMetadata(input: NotificationInput): void {
    if (!input.toolContext || typeof input.toolContext !== "object") {
      return;
    }

    const maybeMetadata = (input.toolContext as { metadata?: unknown }).metadata;
    if (typeof maybeMetadata !== "function") {
      return;
    }

    try {
      (maybeMetadata as (payload: unknown) => void)({
        type: "discipline.notification",
        event: input.event,
        title: input.title,
        message: input.message,
        sessionID: input.sessionID,
        createdAt: new Date().toISOString()
      });
    } catch {
      // Ignore metadata transport errors and continue normal workflow.
    }
  }

  private emitOsNotification(input: NotificationInput): void {
    if (this.commandTemplate) {
      const isWindows = process.platform === "win32";
      const command = interpolateNotificationCommand(
        this.commandTemplate,
        input,
        isWindows ? escapeCmdExeValue : shellEscape
      );
      this.spawnDetached(
        isWindows ? "cmd.exe" : "sh",
        isWindows ? ["/d", "/s", "/c", command] : ["-lc", command],
        { env: buildNotificationEnv(input) }
      );
      return;
    }

    if (process.platform === "darwin") {
      const script = `display notification "${escapeAppleScriptString(input.message)}" with title "${escapeAppleScriptString(input.title)}"`;
      this.spawnDetached("osascript", ["-e", script]);
      return;
    }

    if (process.platform === "linux") {
      this.spawnDetached("notify-send", [input.title, input.message]);
      return;
    }

    if (process.platform === "win32") {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "$notify = New-Object System.Windows.Forms.NotifyIcon;",
        "$notify.Icon = [System.Drawing.SystemIcons]::Information;",
        `$notify.BalloonTipTitle = '${escapePowerShellString(input.title)}';`,
        `$notify.BalloonTipText = '${escapePowerShellString(input.message)}';`,
        "$notify.Visible = $true;",
        "$notify.ShowBalloonTip(4000)"
      ].join(" ");

      this.spawnDetached("powershell", ["-NoProfile", "-Command", script]);
    }
  }

  private spawnDetached(
    command: string,
    args: string[],
    options?: {
      env?: NodeJS.ProcessEnv;
    }
  ): void {
    try {
      const child = spawn(command, args, {
        stdio: "ignore",
        detached: true,
        ...options
      });
      child.on("error", () => {
        // Ignore missing notifier binary and continue silently.
      });
      child.unref();
    } catch {
      // Ignore launcher failures to avoid impacting planning flow.
    }
  }
}

function hasStringProp(obj: object, key: string): obj is Record<string, unknown> & { [K in typeof key]: string } {
  return key in obj && typeof (obj as Record<string, unknown>)[key] === "string";
}

function extractSessionID(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }

  if (hasStringProp(result, "id")) {
    return result.id as string;
  }

  if ("data" in result && result.data && typeof result.data === "object" && hasStringProp(result.data, "id")) {
    return result.data.id as string;
  }

  return undefined;
}

function extractSessionIDFromHookInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  if (hasStringProp(input, "sessionID")) {
    return input.sessionID as string;
  }

  if (hasStringProp(input, "id")) {
    return input.id as string;
  }

  const value = input as Record<string, unknown>;
  const path = value.path;
  if (path && typeof path === "object" && hasStringProp(path, "id")) {
    return path.id as string;
  }

  const session = value.session;
  if (session && typeof session === "object" && hasStringProp(session, "id")) {
    return session.id as string;
  }

  return undefined;
}

function extractAgentFromHookInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  if (hasStringProp(input, "agent")) {
    return (input.agent as string).toLowerCase();
  }

  const value = input as Record<string, unknown>;
  const session = value.session;
  if (session && typeof session === "object" && hasStringProp(session, "agent")) {
    return (session.agent as string).toLowerCase();
  }

  return undefined;
}

function getWaveLabel(wave: 1 | 2 | 3 | 4): string {
  return WAVE_NAMES[wave];
}

function toWorktreeRelativePath(worktree: string, filePath: string): string {
  const absolutePath = resolve(worktree, filePath);
  return relative(worktree, absolutePath).replaceAll("\\", "/");
}

function isPlanMarkdownFile(worktree: string, filePath: string): boolean {
  const relativePath = toWorktreeRelativePath(worktree, filePath);
  return relativePath.startsWith("tasks/plans/") && relativePath.endsWith(".md");
}

function isBlockedEnvRead(filePath: string): boolean {
  const fileName = basename(filePath).toLowerCase();
  if (fileName === ".env") {
    return true;
  }

  if (fileName === ".env.example") {
    return false;
  }

  return fileName.startsWith(".env.");
}

function buildWaveStateSystemBlock(wave: 1 | 2 | 3 | 4, planName: string): string {
  const advanceGuidance =
    wave === 1
      ? "Call `advance_wave` only after Wave 1 interview + checklist work is complete."
      : wave === 2
        ? "Call `advance_wave` only after the Wave 2 Oracle check has completed and gap analysis is done."
        : wave === 3
          ? "Call `advance_wave` only after the plan file is written and Wave 3 is complete."
          : "Do not call `advance_wave` again unless you are truly done with Wave 4 and ready for handoff decisions.";

  return [
    "## 🔒 Discipline Plugin — Wave State",
    "",
    `**Current wave**: ${wave} — ${getWaveLabel(wave)}`,
    `**Plan name**: ${planName}`,
    `**Plan file**: tasks/plans/${planName}.md`,
    "",
    "### Wave rules:",
    "- Wave 1 (Interview): Ask clarifying questions. Delegate to @explore and @librarian. Do NOT write the plan yet.",
    "- Wave 2 (Gap Analysis): Check for hidden intent, over-engineering, missing context, ambiguity, breaking changes. MANDATORY: consult @oracle in this wave before advancing. Do NOT write the plan yet.",
    "- Wave 3 (Plan Generation): NOW write the plan to tasks/plans/{planName}.md using the structured template.",
    "- Wave 4 (Review): Self-review the plan. Delegate to @oracle for high-stakes decisions. Edit the plan if needed.",
    "",
    `**You are in Wave ${wave}.** ${advanceGuidance}`,
    "**Writing to tasks/plans/*.md is BLOCKED until Wave 3.**"
  ].join("\n");
}

function buildWave2OraclePrompt(): string {
  return [
    "## MANDATORY: Wave 2 Oracle Check",
    "Before you can advance to Wave 3, delegate to `@oracle` once for a gap-analysis sanity check.",
    "Use the Task tool with `subagent_type: \"oracle\"` and summarize the result in your analysis.",
    "Wave 2 -> 3 is enforced: `advance_wave` will fail until this Oracle check is completed.",
    "Do NOT retry `advance_wave` until the Oracle task returns successfully."
  ].join("\n");
}

function buildPlanReadOnlyReminder(): string {
  return [
    "## CRITICAL: Plan mode ACTIVE - you are in READ-ONLY phase...",
    "- Implementation edits are forbidden while planning",
    "- Only read, analyze, delegate, and plan",
    "- Do not execute implementation",
    "- Writing to tasks/plans/*.md remains blocked until Wave 3"
  ].join("\n");
}

function buildPostAcceptPrompt(planName: string): string {
  const planPath = `tasks/plans/${planName}.md`;
  return [
    "## Discipline Plugin — Plan Accepted",
    "",
    `The plan \`${planPath}\` has been accepted and the planning session is complete.`,
    "",
    "**You are DONE. Do not call any more tools. Do not call advance_wave. Do not take further action.**",
    "",
    "Tell the user the plan is accepted and ready for a Build agent to execute.",
    "If the automatic Build session handoff succeeded, confirm that.",
    "If it fell back to manual, tell the user to switch to the Build agent."
  ].join("\n");
}

function buildPlanHandoffPrompt(planName: string): string {
  const planPath = `tasks/plans/${planName}.md`;
  return [
    "## MANDATORY: Plan Handoff — Present Choices Now",
    "",
    `The plan file \`${planPath}\` has been written and Wave 4 review is complete.`,
    "You MUST present the following choices to the user. Do NOT skip this step.",
    "Do NOT say 'switch to Build' or any other freeform handoff text.",
    "",
    "Present this EXACTLY:",
    "",
    "---",
    "**Choose one:**",
    `1. **Accept plan, clear context and build.** — I'll call \`accept_plan\` to create a new Build session with clean context and start implementing \`${planPath}\` immediately.`,
    "2. **Start work later** — The plan is saved. You can start a Build session whenever you're ready.",
    "3. **I have modifications to make** — Stay in review mode so you can request changes.",
    "---",
    "",
    "Then wait for the user's response before taking any action.",
    "- If the user picks option 1: call `accept_plan(action=\"accept\")`",
    "- If the user picks option 2: do nothing, confirm the plan is saved",
    "- If the user picks option 3: call `accept_plan(action=\"revise\")`, ask what to change, and after revisions present these choices again"
  ].join("\n");
}

function buildCompactionContext(state: {
  wave: 1 | 2 | 3 | 4;
  planName: string;
  oracleReviewedAt?: string;
  acceptedAt?: string;
  acceptedBySessionID?: string;
}): string {
  const oracleLine = state.oracleReviewedAt
    ? `Oracle gap review completed at: ${state.oracleReviewedAt}`
    : "Oracle gap review pending for Wave 2 -> 3 transition.";

  const acceptedLine = state.acceptedAt
    ? `Accepted timestamp: ${state.acceptedAt}${state.acceptedBySessionID ? ` (build session ${state.acceptedBySessionID})` : ""}`
    : "accept_plan controls handoff to Build; if accepted, preserve build session id and accepted timestamp.";

  return [
    "## Discipline Plugin — Compaction Context",
    "",
    "CRITICAL: Preserve the following state across compaction:",
    `- Current planning wave: ${state.wave} (${getWaveLabel(state.wave)})`,
    `- Plan name: ${state.planName}`,
    `- Plan file target: tasks/plans/${state.planName}.md`,
    "- The advance_wave tool must be called to progress between waves.",
    `- ${oracleLine}`,
    "- Writing to tasks/plans/*.md is blocked until Wave 3.",
    `- ${acceptedLine}`,
    "",
    `Resume from Wave ${state.wave} after compaction.`
  ].join("\n");
}

function buildPlanningTodos(planName: string): Array<Pick<Todo, "content" | "status" | "priority">> {
  const planPath = `tasks/plans/${planName}.md`;
  return [
    {
      content: "Wave 1: Interview - clarify requirements, scope, constraints, and success criteria",
      status: "in_progress",
      priority: "high"
    },
    {
      content: "Wave 2: Gap Analysis - surface hidden intent, ambiguity, risks, and breaking changes",
      status: "pending",
      priority: "high"
    },
    {
      content: `Wave 3: Plan Generation - write the structured plan file at ${planPath}`,
      status: "pending",
      priority: "high"
    },
    {
      content: "Wave 4: Review - self-review clarity, verification, scope, and implementation readiness",
      status: "pending",
      priority: "high"
    },
    {
      content:
        "Step 5: Ask user to confirm - choose one: Accept plan, clear context and build. / Start work later / I have modifications to make",
      status: "pending",
      priority: "high"
    }
  ];
}

function normalizeTodoContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

function isPlanContext(agent?: string): boolean {
  return agent === undefined || agent === "plan";
}

function extractSubagentType(args: unknown): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }

  const value = args as Record<string, unknown>;
  const direct =
    typeof value.subagent_type === "string"
      ? value.subagent_type
      : typeof value.subagentType === "string"
        ? value.subagentType
        : undefined;

  return direct?.toLowerCase();
}

function extractTodosFromTodoWriteArgs(args: unknown): Todo[] {
  if (!args || typeof args !== "object") {
    return [];
  }

  const value = args as Record<string, unknown>;
  if (!("todos" in value)) {
    return [];
  }

  return extractTodos(value.todos);
}

function buildQuestionNotificationText(args: unknown): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }

  const value = args as Record<string, unknown>;
  const rawQuestions = value.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return undefined;
  }

  const prompts = rawQuestions
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }

      const question = (item as Record<string, unknown>).question;
      return typeof question === "string" ? question.trim() : undefined;
    })
    .filter((item): item is string => Boolean(item));

  if (prompts.length === 0) {
    return undefined;
  }

  const first = prompts[0];
  if (prompts.length === 1) {
    return first;
  }

  return `${prompts.length} questions waiting. First: ${first}`;
}

function getOrCreateTodoNudgeState(ctx: PluginContext, sessionID: string): TodoNudgeState {
  const existing = ctx.todoNudges.get(sessionID);
  if (existing) {
    return existing;
  }

  const created: TodoNudgeState = {
    prompted: false,
    retried: false,
    seeded: false
  };
  ctx.todoNudges.set(sessionID, created);
  return created;
}

async function hasPlanningChecklistSeeded(
  ctx: PluginContext,
  sessionID: string,
  planName: string
): Promise<boolean> {
  const nudgeState = getOrCreateTodoNudgeState(ctx, sessionID);
  if (nudgeState.seeded) {
    return true;
  }

  const todos = await readSessionTodos(ctx.client, ctx.directory, sessionID);
  if (todos === undefined) {
    return true;
  }

  const hasChecklist = hasPlanningTodoChecklist(todos, planName);
  if (hasChecklist) {
    nudgeState.seeded = true;
    ctx.todoNudges.set(sessionID, nudgeState);
  }

  return hasChecklist;
}

function buildTodoSeedInstruction(planName: string, retry: boolean): string {
  const todoItems = buildPlanningTodos(planName);
  const title = retry
    ? "## Discipline Plugin — Todo Seed Retry"
    : "## Discipline Plugin — Todo Seed";
  const intro = retry
    ? "The planning checklist is still missing in the right panel."
    : "Before continuing, create the planning checklist in the right panel.";

  const todoLines = todoItems.map((todo, index) => {
    return `${index + 1}. content: \`${todo.content}\` | status: \`${todo.status}\` | priority: \`${todo.priority}\``;
  });

  return [
    title,
    intro,
    "Call `todowrite` now with these five items:",
    ...todoLines
  ].join("\n");
}

function extractTodos(response: unknown): Todo[] {
  if (Array.isArray(response)) {
    return response.filter((item): item is Todo => {
      return (
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).content === "string" &&
        typeof (item as Record<string, unknown>).status === "string" &&
        typeof (item as Record<string, unknown>).priority === "string"
      );
    });
  }

  if (response && typeof response === "object") {
    const data = (response as { data?: unknown }).data;
    if (Array.isArray(data)) {
      return extractTodos(data);
    }
  }

  return [];
}

function hasPlanningTodoChecklist(todos: Todo[], _planName: string): boolean {
  const normalizedTodos = todos.map((todo) => normalizeTodoContent(todo.content));

  // Match on wave/step identifiers only — don't require exact description wording.
  // The LLM naturally customizes descriptions to be contextual, which is fine.
  const requiredIdentifiers = [
    "wave 1",
    "wave 2",
    "wave 3",
    "wave 4",
    "step 5"
  ];

  return requiredIdentifiers.every((identifier) => {
    return normalizedTodos.some((content) => content.includes(identifier));
  });
}

async function readSessionTodos(
  client: unknown,
  directory: string,
  sessionID: string
): Promise<Todo[] | undefined> {
  const sessionApi = (client as { session?: Record<string, unknown> }).session;
  if (!sessionApi || typeof sessionApi.todo !== "function") {
    return undefined;
  }

  try {
    const response = await (
      sessionApi.todo as (input: Record<string, unknown>) => Promise<unknown>
    )({
      query: { directory },
      path: { id: sessionID }
    });
    return extractTodos(response);
  } catch (error) {
    console.warn("[discipline] readSessionTodos failed:", error);
    return undefined;
  }
}

// --- Hook handlers ---

async function handleCompacting(
  ctx: PluginContext,
  input: { sessionID: string },
  output: { context: string[] }
): Promise<void> {
  const state = ctx.manager.getState(input.sessionID);
  if (!state) {
    return;
  }

  output.context.push(buildCompactionContext(state));
}

async function handleSessionIdle(
  ctx: PluginContext,
  input: unknown,
  _output: unknown
): Promise<void> {
  const sessionID = extractSessionIDFromHookInput(input);
  if (!sessionID) {
    return;
  }

  const agent = extractAgentFromHookInput(input);
  const isBuildIdle = agent === "build" || ctx.manager.isAcceptedBuildSession(sessionID);
  if (!isBuildIdle) {
    return;
  }

  ctx.notifications.notify({
    sessionID,
    event: "coding_complete",
    title: "OpenCode has finished",
    message: "The Build agent is done and OpenCode is ready for input.",
    dedupeKey: "session-idle-coding-complete",
    toolContext: input
  });
}

async function handleSystemTransform(
  ctx: PluginContext,
  input: { sessionID?: string; agent?: string },
  output: { system: string[] }
): Promise<void> {
  const sessionID = input.sessionID;
  const state = sessionID ? ctx.manager.getState(sessionID) : undefined;

  if (!state) {
    output.system.push(
      "## Discipline Plugin\nYou are operating under the opencode-discipline plugin. To start a structured plan, call `advance_wave` to begin Wave 1 (Interview)."
    );
    return;
  }

  output.system.push(buildWaveStateSystemBlock(state.wave, state.planName));

  if (state.accepted) {
    output.system.push(buildPostAcceptPrompt(state.planName));
    return;
  }

  if (isPlanContext(input.agent) && state.wave < 3) {
    output.system.push(buildPlanReadOnlyReminder());
  }

  if (isPlanContext(input.agent) && state.wave === 2 && !state.oracleReviewedAt) {
    output.system.push(buildWave2OraclePrompt());
  }

  if (state.wave === 4) {
    const planFilePath = resolve(ctx.worktree, `tasks/plans/${state.planName}.md`);
    if (existsSync(planFilePath)) {
      if (sessionID) {
        ctx.notifications.notify({
          sessionID,
          event: "plan_ready",
          title: "Plan is ready",
          message: `tasks/plans/${state.planName}.md is ready for handoff review.`,
          dedupeKey: "wave-4-plan-ready"
        });
      }

      output.system.push(buildPlanHandoffPrompt(state.planName));
    }
  }

  if (sessionID && isPlanContext(input.agent)) {
    const nudgeState = getOrCreateTodoNudgeState(ctx, sessionID);

    const todos = await readSessionTodos(ctx.client, ctx.directory, sessionID);
    const hasSeededTodo =
      todos !== undefined && hasPlanningTodoChecklist(todos, state.planName);

    if (hasSeededTodo) {
      nudgeState.seeded = true;
    }

    if (!nudgeState.seeded) {
      if (!nudgeState.prompted) {
        output.system.push(buildTodoSeedInstruction(state.planName, false));
        nudgeState.prompted = true;
      } else if (todos !== undefined && !hasSeededTodo && !nudgeState.retried) {
        output.system.push(buildTodoSeedInstruction(state.planName, true));
        nudgeState.retried = true;
      }
    }

    ctx.todoNudges.set(sessionID, nudgeState);
  }
}

async function handleToolExecuteBefore(
  ctx: PluginContext,
  input: { tool: string; sessionID: string; callID: string },
  output: { args: any; metadata?: unknown }
): Promise<void> {
  if (input.tool === "question") {
    const QUESTION_FALLBACK = "The agent asked a question and is waiting for your answer.";
    const sourceText = buildQuestionNotificationText(output.args) ?? QUESTION_FALLBACK;
    const condensed = sourceText.replace(/\s+/g, " ").trim();
    const questionText = condensed.length > 180 ? `${condensed.slice(0, 177)}...` : condensed;

    ctx.notifications.notify({
      sessionID: input.sessionID,
      event: "need_answers",
      title: "Agent needs your answers",
      message: questionText,
      dedupeKey: `question-${input.callID}`,
      toolContext: output
    });
  }

  const filePath = output.args?.filePath;
  if (typeof filePath === "string") {
    if (input.tool === "read" && isBlockedEnvRead(filePath)) {
      throw new Error("Reading .env files is blocked by opencode-discipline.");
    }

    if (input.tool === "edit" || input.tool === "write") {
      const state = ctx.manager.getState(input.sessionID);

      if (state?.accepted) {
        throw new Error(
          "Plan session is read-only after accept_plan(action=\"accept\"). Switch to Build for implementation."
        );
      }

      if (state && state.wave < 3 && isPlanMarkdownFile(ctx.worktree, filePath)) {
        throw new Error(
          `Cannot write plan files until Wave 3 (Plan Generation). Current wave: ${state.wave}. Call advance_wave to progress.`
        );
      }
    }
  }
}

async function handleToolExecuteAfter(
  ctx: PluginContext,
  input: { tool: string; sessionID: string; callID: string; args: unknown },
  output: { title: string; output: string; metadata: unknown }
): Promise<void> {
  const state = ctx.manager.getState(input.sessionID);
  if (!state || state.accepted) {
    return;
  }

  if (input.tool === "todowrite") {
    const todos = extractTodosFromTodoWriteArgs(input.args);
    if (hasPlanningTodoChecklist(todos, state.planName)) {
      const nudgeState = getOrCreateTodoNudgeState(ctx, input.sessionID);
      nudgeState.seeded = true;
      ctx.todoNudges.set(input.sessionID, nudgeState);
    }
    return;
  }

  if (input.tool !== "task") {
    return;
  }

  const trimmedOutput = output.output.trim();
  if (trimmedOutput.startsWith("Error:") || trimmedOutput.startsWith("error:")) {
    return;
  }

  if (state.wave < 2) {
    return;
  }

  if (extractSubagentType(input.args) !== "oracle") {
    return;
  }

  ctx.manager.markOracleReviewed(input.sessionID, input.callID);
}

function createAdvanceWaveTool(ctx: PluginContext) {
  return tool({
    description:
      "Advance the planning wave. Call this to move from one wave to the next. Wave 1: Interview, Wave 2: Gap Analysis, Wave 3: Plan Generation, Wave 4: Review. You must call this before starting each wave. The first call starts a new plan and generates the plan filename.",
    args: {
      sessionID: tool.schema.string().describe("The current session ID")
    },
    async execute(args, context) {
      if (context.agent !== "plan") {
        return "Error: advance_wave is only available to the Plan agent.";
      }

      try {
        const current = ctx.manager.getState(args.sessionID);

        if (current?.wave === 1 && !current.accepted) {
          const hasChecklist = await hasPlanningChecklistSeeded(
            ctx,
            args.sessionID,
            current.planName
          );
          if (!hasChecklist) {
            return [
              "Error: planning checklist is missing.",
              "Call `todowrite` with the required Wave 1-4 phase items and the Step 5 handoff item before advancing to Wave 2.",
              `Expected plan file reference: tasks/plans/${current.planName}.md`
            ].join(" ");
          }
        }

        const state = current
          ? ctx.manager.advanceWave(args.sessionID)
          : ctx.manager.startPlan(args.sessionID);

        if (!current) {
          ctx.todoNudges.set(args.sessionID, {
            prompted: false,
            retried: false,
            seeded: false
          });
        }

        const waveName = WAVE_NAMES[state.wave];
        const nextStep = WAVE_NEXT_STEPS[state.wave];

        const advanceWhen =
          state.wave === 1
            ? "Call `advance_wave` only after interview + checklist work is complete."
            : state.wave === 2
              ? "Call `advance_wave` only after Oracle review is complete and gap analysis is done."
              : state.wave === 3
                ? "Call `advance_wave` only after the plan file is written."
                : "Stay in Wave 4 for plan review/handoff; call `advance_wave` only if explicitly needed (normally you should use `accept_plan`).";

        if (state.wave === 4) {
          const planFilePath = resolve(ctx.worktree, `tasks/plans/${state.planName}.md`);
          if (existsSync(planFilePath)) {
            ctx.notifications.notify({
              sessionID: args.sessionID,
              event: "plan_ready",
              title: "Plan is ready",
              message: `tasks/plans/${state.planName}.md is ready for handoff review.`,
              dedupeKey: "wave-4-plan-ready",
              toolContext: context
            });
          }
        }

        return `Wave ${state.wave} (${waveName}) started for plan '${state.planName}'. You may now proceed with ${nextStep}. ${advanceWhen}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";

        if (message.includes("Cannot advance to Wave 3 before Oracle gap review is completed")) {
          return [
            `Error: ${message}`,
            "You are still in Wave 2 (Gap Analysis).",
            "Next action: run Task with subagent_type=\"oracle\" and wait for successful completion.",
            "Do NOT call advance_wave again until that Oracle task succeeds."
          ].join(" ");
        }

        return `Error: ${message}`;
      }
    }
  });
}

function createAcceptPlanTool(ctx: PluginContext) {
  return tool({
    description:
      "Accept or revise the generated plan. Use action='revise' to keep planning in Wave 4, or action='accept' to hand off to Build with only the plan path.",
    args: {
      sessionID: tool.schema.string().describe("The current plan session ID"),
      action: tool.schema.enum(["accept", "revise"]),
      planPath: tool.schema
        .string()
        .optional()
        .describe("Optional relative or absolute path to the plan file")
    },
    async execute(args, context) {
      if (context.agent !== "plan") {
        return "Error: accept_plan is only available to the Plan agent.";
      }

      const state = ctx.manager.getState(args.sessionID);
      if (!state) {
        return `Error: No active plan found for session '${args.sessionID}'.`;
      }

      const defaultPlanPath = `tasks/plans/${state.planName}.md`;
      const resolvedPlanPath = args.planPath ?? defaultPlanPath;
      const absolutePlanPath = resolve(ctx.worktree, resolvedPlanPath);
      const relativePlanPath = toWorktreeRelativePath(ctx.worktree, absolutePlanPath);

      if (!isPlanMarkdownFile(ctx.worktree, absolutePlanPath)) {
        return "Error: planPath must point to tasks/plans/{planName}.md within the current worktree.";
      }

      if (args.action === "revise") {
        const nextStep =
          state.wave < 4
            ? "Next step: call advance_wave until Wave 4, then continue review/revision."
            : "Next step: continue in Wave 4 review/revision and update the plan as needed.";

        return [
          "Plan revision requested.",
          `Current wave: ${state.wave} (${getWaveLabel(state.wave)}).`,
          `Plan file: ${relativePlanPath}`,
          nextStep
        ].join(" ");
      }

      if (state.wave !== 4) {
        return `Error: accept_plan(action=\"accept\") is only available in Wave 4 (Review). Current wave: ${state.wave}.`;
      }

      try {
        accessSync(absolutePlanPath, constants.R_OK);
      } catch {
        return `Error: Plan file '${relativePlanPath}' is missing or unreadable.`;
      }

      let buildSessionID = "manual-build-session";
      let fallback = false;

      const sessionApi = (ctx.client as unknown as { session?: Record<string, unknown> }).session;
      const canCreate = sessionApi && typeof sessionApi.create === "function";
      const canPrompt = sessionApi && typeof sessionApi.prompt === "function";

      if (canCreate && canPrompt) {
        try {
          const createResult = await (
            sessionApi.create as (input: Record<string, unknown>) => Promise<unknown>
          )({
            query: { directory: ctx.directory },
            body: { title: `Build handoff: ${state.planName}` }
          });

          const createdSessionID = extractSessionID(createResult);
          if (!createdSessionID) {
            fallback = true;
          } else {
            buildSessionID = createdSessionID;
            await (
              sessionApi.prompt as (input: Record<string, unknown>) => Promise<unknown>
            )({
              query: { directory: ctx.directory },
              path: { id: createdSessionID },
              body: {
                agent: "build",
                system:
                  "Use only this file as source of truth; do not rely on Plan context.",
                parts: [
                  {
                    type: "text",
                    text: `Read ${relativePlanPath} and implement it phase-by-phase. Use only this plan file as handoff context.`
                  }
                ]
              }
            });
          }
        } catch {
          fallback = true;
        }
      } else {
        fallback = true;
      }

      const acceptedState = ctx.manager.markAccepted(args.sessionID, buildSessionID);

      if (fallback) {
        return [
          "Plan accepted.",
          `Plan file: ${relativePlanPath}`,
          "Direct session handoff is unavailable in this environment.",
          "Fallback: tell the user to switch to the Build agent and read the plan file.",
          `State saved with accepted timestamp ${acceptedState.acceptedAt}.`,
          "IMPORTANT: The planning session is now COMPLETE. Do NOT call advance_wave or any other tools. Just confirm to the user."
        ].join(" ");
      }

      return [
        "Plan accepted and handed off to Build.",
        `Plan file: ${relativePlanPath}`,
        `Build session: ${buildSessionID}`,
        "First build action seeded: read the plan file with clean handoff context.",
        `State saved with accepted timestamp ${acceptedState.acceptedAt}.`,
        "IMPORTANT: The planning session is now COMPLETE. Do NOT call advance_wave or any other tools. Just confirm to the user."
      ].join(" ");
    }
  });
}

// --- Plugin entry point ---

export const DisciplinePlugin: Plugin = async ({ worktree, directory, client }) => {
  const pluginDir = dirname(fileURLToPath(import.meta.url));
  const pluginVersion = readPluginVersion(pluginDir);
  const agentConfigs = loadAgentConfigs(resolve(pluginDir, "../agents"));
  const commandsSourceDir = resolve(pluginDir, "../commands");
  const commandConfigs = loadCommandConfigs(commandsSourceDir);

  // Install command markdown files into global command directory
  installGlobalCommandFiles(commandsSourceDir);

  const ctx: PluginContext = {
    manager: new WaveStateManager(worktree),
    todoNudges: new Map<string, TodoNudgeState>(),
    notifications: new NotificationManager(),
    worktree,
    directory,
    client
  };

  queueMicrotask(() => {
    void showStartupToast(client, directory, pluginVersion).finally(() => {
      if (!startupToastShownByDirectory.has(directory)) {
        scheduleStartupToastRetry(client, directory, pluginVersion);
      }
    });
  });

  return {
    config: async (input) => {
      const agents = (input as Record<string, unknown>).agent as
        | Record<string, Record<string, unknown> | undefined>
        | undefined;
      const commands = (input as Record<string, unknown>).command as
        | Record<string, Record<string, unknown> | undefined>
        | undefined;
      const merged: Record<string, Record<string, unknown>> = {};
      const mergedCommands: Record<string, Record<string, unknown>> = {};

      for (const [name, pluginConfig] of Object.entries(agentConfigs)) {
        merged[name] = { ...pluginConfig, ...(agents?.[name] ?? {}) };
      }

      for (const [name, pluginCommand] of Object.entries(commandConfigs)) {
        mergedCommands[name] = { ...pluginCommand, ...(commands?.[name] ?? {}) };
      }

      (input as Record<string, unknown>).agent = { ...agents, ...merged };
      (input as Record<string, unknown>).command = { ...commands, ...mergedCommands };
    },
    event: (input) => handleEvent(ctx, input, pluginVersion),
    "experimental.session.compacting": (input, output) => handleCompacting(ctx, input, output),
    "experimental.chat.system.transform": (input, output) => handleSystemTransform(ctx, input, output),
    "tool.execute.before": (input, output) => handleToolExecuteBefore(ctx, input, output),
    "tool.execute.after": (input, output) => handleToolExecuteAfter(ctx, input, output),
    "session.idle": (input: unknown, output: unknown) => handleSessionIdle(ctx, input, output),
    tool: {
      advance_wave: createAdvanceWaveTool(ctx),
      accept_plan: createAcceptPlanTool(ctx)
    }
  };
};
