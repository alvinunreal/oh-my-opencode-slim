import path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import type { PluginConfig } from '../config';
import { log } from '../utils';
import {
  DEFAULT_DASHBOARD_PORT,
  probeDashboard,
  readDashboardAuthFile,
  tryBecomeDashboard,
} from './dashboard';
import { createInterviewServer } from './server';
import { createInterviewService } from './service';
import type {
  InterviewRecord,
  InterviewState,
  InterviewStateEntry,
} from './types';

/**
 * Interview Manager — Composition root.
 *
 * Two modes:
 *
 * 1. **Dashboard mode** (dashboard:true or port>0):
 *    First process to bind the port becomes the dashboard (dumb aggregator).
 *    Other processes register as sessions and push state to it.
 *    Sessions drive LLM interaction locally, dashboard just serves the web UI.
 *
 * 2. **Per-session mode** (default, port=0, dashboard:false):
 *    Upstream behavior. Each process runs its own interview server on a random
 *    port. Lazy startup on first /interview command.
 */
export function createInterviewManager(
  ctx: PluginInput,
  config: PluginConfig,
): {
  registerCommand: (config: Record<string, unknown>) => void;
  handleCommandExecuteBefore: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>;
  handleEvent: (input: {
    event: { type: string; properties?: Record<string, unknown> };
  }) => Promise<void>;
} {
  const interviewConfig = config.interview;
  const effectivePort = interviewConfig?.port ?? 0;
  const dashboardEnabled =
    interviewConfig?.dashboard === true || effectivePort > 0;
  const outputFolder = interviewConfig?.outputFolder ?? 'interview';

  // ─── Per-session mode (upstream behavior) ───────────────────────
  if (!dashboardEnabled) {
    const service = createInterviewService(ctx, interviewConfig);
    const resolvedOutputPath = path.join(ctx.directory, outputFolder);
    const server = createInterviewServer({
      getState: async (interviewId) => service.getInterviewState(interviewId),
      listInterviewFiles: async () => service.listInterviewFiles(),
      listInterviews: () => service.listInterviews(),
      submitAnswers: async (interviewId, answers) =>
        service.submitAnswers(interviewId, answers),
      handleNudgeAction: async (interviewId, action) =>
        service.handleNudgeAction(interviewId, action),
      outputFolder: resolvedOutputPath,
      port: 0, // random port
    });

    service.setBaseUrlResolver(() => server.ensureStarted());

    return {
      registerCommand: (c) => service.registerCommand(c),
      handleCommandExecuteBefore: async (input, output) =>
        service.handleCommandExecuteBefore(input, output),
      handleEvent: async (input) => service.handleEvent(input),
    };
  }

  // ─── Dashboard mode ─────────────────────────────────────────────
  const dashboardPort =
    effectivePort > 0 ? effectivePort : DEFAULT_DASHBOARD_PORT;
  const service = createInterviewService(ctx, interviewConfig);

  // Async init — resolves once we know our role (dashboard or session)
  let initDone = false;
  let isDashboard = false;
  let dashboardBaseUrl = '';
  let authToken = '';
  let dashboard: Awaited<ReturnType<typeof tryBecomeDashboard>> | null = null;
  const registeredSessions = new Set<string>();

  // ── Timer-based fallback for nudge/answer polling ─────────────
  // Declared here, started later in initPromise once we confirm
  // we're in session mode. References poll functions defined below.
  const FALLBACK_POLL_INTERVAL = 10_000;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  const startFallbackTimer = () => {
    if (fallbackTimer) return;
    fallbackTimer = setInterval(() => {
      if (isDashboard || !dashboardBaseUrl) return;
      for (const sessionID of registeredSessions) {
        const interviewId = service.getActiveInterviewId(sessionID);
        if (!interviewId) continue;
        pollPendingAnswers(sessionID).catch(() => {});
        pollNudgeAction(sessionID).catch(() => {});
      }
    }, FALLBACK_POLL_INTERVAL);
    fallbackTimer?.unref();
  };

  const initPromise = (async () => {
    try {
      dashboard = await tryBecomeDashboard({
        port: dashboardPort,
        outputFolder,
        sessionClient: ctx.client.session,
      });

      if (dashboard) {
        // ── We ARE the dashboard ────────────────────────────────────
        isDashboard = true;
        dashboardBaseUrl = `http://127.0.0.1:${dashboardPort}`;
        authToken = dashboard.authToken;

        service.setBaseUrlResolver(() => Promise.resolve(dashboardBaseUrl));

        // State push: in-process, directly into dashboard cache
        service.setStatePushCallback((id, state) => {
          dashboard?.pushState(stateToEntry(id, state));
        });

        // Interview created: register in dashboard cache immediately
        service.setOnInterviewCreated((interview) => {
          dashboard?.pushState({
            interviewId: interview.id,
            sessionID: interview.sessionID,
            idea: interview.idea,
            mode: 'awaiting-agent',
            summary: 'Interview created.',
            title: interview.idea,
            questions: [],
            pendingAnswers: null,
            lastUpdatedAt: Date.now(),
            filePath: interview.markdownPath,
            nudgeAction: null,
          });
          // Register session directory for file scanning
          dashboard?.registerSession({
            sessionID: interview.sessionID,
            directory: ctx.directory,
            pid: process.pid,
            registeredAt: Date.now(),
          });
        });

        log('[interview] dashboard mode: we are the dashboard', {
          port: dashboardPort,
        });

        // Self-register: dashboard process is also a session with its
        // own directory. This triggers rebuildFromFiles() for failover.
        dashboard.registerSession({
          sessionID: `dashboard-self-${process.pid}`,
          directory: ctx.directory,
          pid: process.pid,
          registeredAt: Date.now(),
        });

        // Discover directories from past sessions via SDK
        await dashboard.discoverSessionDirectories();
        await dashboard.refreshFiles();
      } else {
        // ── We're a SESSION ─────────────────────────────────────────
        const probe = await probeDashboard(dashboardPort);
        if (!probe.alive) {
          // Brief retry — dashboard may still be starting
          await new Promise((r) => setTimeout(r, 500));
          const retry = await probeDashboard(dashboardPort);
          if (!retry.alive) {
            log(
              '[interview] dashboard mode: no dashboard found, falling back to per-session server',
              {
                port: dashboardPort,
              },
            );
            // Fall back to per-session mode — start our own server
            const perSessionServer = createInterviewServer({
              getState: async (interviewId) =>
                service.getInterviewState(interviewId),
              listInterviewFiles: async () => service.listInterviewFiles(),
              listInterviews: () => service.listInterviews(),
              submitAnswers: async (interviewId, answers) =>
                service.submitAnswers(interviewId, answers),
              handleNudgeAction: async (interviewId, action) =>
                service.handleNudgeAction(interviewId, action),
              outputFolder: path.join(ctx.directory, outputFolder),
              port: 0, // random port
            });
            service.setBaseUrlResolver(() => perSessionServer.ensureStarted());
            isDashboard = false;
            initDone = true;
            return;
          }
        }

        dashboardBaseUrl = `http://127.0.0.1:${dashboardPort}`;
        const auth = await readDashboardAuthFile(dashboardPort);
        authToken = auth?.token ?? '';

        service.setBaseUrlResolver(() => Promise.resolve(dashboardBaseUrl));

        // State push: HTTP to dashboard
        service.setStatePushCallback((id, state) => {
          pushStateViaHttp(dashboardBaseUrl, authToken, id, state).catch(
            (err) => {
              log('[interview] failed to push state to dashboard', {
                error: err instanceof Error ? err.message : String(err),
              });
            },
          );
        });

        // Interview created: POST to dashboard so it appears immediately
        service.setOnInterviewCreated((interview) => {
          registerInterviewViaHttp(
            dashboardBaseUrl,
            authToken,
            interview,
          ).catch((err) => {
            log('[interview] failed to register interview with dashboard', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        });

        log('[interview] dashboard mode: we are a session', {
          port: dashboardPort,
        });

        // Start fallback poll timer now that we know we're in session mode
        startFallbackTimer();
      }
    } catch (err) {
      log('[interview] dashboard mode init failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      initDone = true;
    }
  })();

  async function ensureInit(): Promise<void> {
    if (!initDone) await initPromise;
  }

  // ── Lazy session registration ──────────────────────────────────
  // Register with dashboard on first hook call that includes a
  // session ID. Dashboard needs our directory for file scanning.
  async function registerSessionIfNeeded(sessionID: string): Promise<void> {
    if (registeredSessions.has(sessionID)) return;
    registeredSessions.add(sessionID);
    if (isDashboard) return;

    try {
      await fetch(`${dashboardBaseUrl}/api/register?token=${authToken}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionID,
          directory: ctx.directory,
          pid: process.pid,
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch (err) {
      log('[interview] failed to register session with dashboard', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Answer polling ─────────────────────────────────────────────
  // When LLM finishes responding (session goes idle), check if the
  // user submitted answers via the dashboard UI while we were busy.
  async function pollPendingAnswers(sessionID: string): Promise<void> {
    const interviewId = service.getActiveInterviewId(sessionID);
    if (!interviewId) return;

    try {
      const response = await fetch(
        `${dashboardBaseUrl}/api/interviews/${interviewId}/pending?token=${authToken}`,
        { signal: AbortSignal.timeout(3000) },
      );
      if (!response.ok) return;

      const data = (await response.json()) as {
        answers: Array<{ questionId: string; answer: string }> | null;
      };
      if (!data.answers || data.answers.length === 0) return;

      log('[interview] delivering pending answers from dashboard', {
        interviewId,
        count: data.answers.length,
      });

      // submitAnswers reads answers, injects prompt locally, and
      // the resulting state push updates the dashboard cache
      await service.submitAnswers(interviewId, data.answers);
    } catch (err) {
      log('[interview] failed to poll pending answers', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Nudge polling ──────────────────────────────────────────────
  // Check if the user nudged the agent from the dashboard UI.
  async function pollNudgeAction(sessionID: string): Promise<void> {
    const interviewId = service.getActiveInterviewId(sessionID);
    if (!interviewId) return;

    try {
      const response = await fetch(
        `${dashboardBaseUrl}/api/interviews/${interviewId}/nudge?token=${authToken}`,
        { signal: AbortSignal.timeout(3000) },
      );
      if (!response.ok) return;

      const data = (await response.json()) as {
        action: 'more-questions' | 'confirm-complete' | null;
      };
      if (!data.action) return;

      log('[interview] delivering nudge action from dashboard', {
        interviewId,
        action: data.action,
      });

      await service.handleNudgeAction(interviewId, data.action);
    } catch (err) {
      log('[interview] failed to poll nudge action', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    registerCommand: (c) => service.registerCommand(c),

    handleCommandExecuteBefore: async (input, output) => {
      await ensureInit();
      await service.handleCommandExecuteBefore(input, output);
      if (input.sessionID) {
        await registerSessionIfNeeded(input.sessionID);
      }
    },

    handleEvent: async (input) => {
      await ensureInit();
      await service.handleEvent(input);

      const { event } = input;
      const properties = event.properties ?? {};
      const sessionID = properties.sessionID as string | undefined;

      // Register session on first sighting
      if (sessionID) {
        await registerSessionIfNeeded(sessionID);
      }

      // When LLM finishes responding, push updated state + poll for pending answers
      if (event.type === 'session.status' && sessionID) {
        const status = properties.status as { type?: string } | undefined;
        if (status?.type === 'idle') {
          const interviewId = service.getActiveInterviewId(sessionID);

          // Process pending nudges/answers BEFORE refreshing state.
          // handleNudgeAction sets sessionBusy=true, so the state refresh
          // below correctly pushes 'awaiting-agent' instead of 'completed'.
          if (!isDashboard) {
            // Session mode: HTTP poll the dashboard
            await pollPendingAnswers(sessionID);
            await pollNudgeAction(sessionID);
          } else if (interviewId && dashboard) {
            // Dashboard mode: read directly from in-process cache
            const pending = dashboard.consumePendingAnswers(interviewId);
            if (pending && pending.length > 0) {
              log('[interview] delivering pending answers (in-process)', {
                interviewId,
                count: pending.length,
              });
              await service.submitAnswers(interviewId, pending);
            }
            const nudge = dashboard.consumeNudgeAction(interviewId);
            if (nudge) {
              log('[interview] delivering nudge action (in-process)', {
                interviewId,
                action: nudge,
              });
              await service.handleNudgeAction(interviewId, nudge);
            }
          }

          // Refresh state: calls getInterviewState → syncInterview → onStateChange
          // This runs AFTER nudge/answer processing so sessionBusy is accurate.
          if (interviewId) {
            service.getInterviewState(interviewId).catch((err) => {
              log('[interview] failed to refresh state', {
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        }
      }

      // Clean up when a session is deleted
      if (event.type === 'session.deleted' && sessionID) {
        registeredSessions.delete(sessionID);
        dashboard?.removeSession(sessionID);
      }
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────

function stateToEntry(
  interviewId: string,
  state: InterviewState,
): InterviewStateEntry {
  return {
    interviewId,
    sessionID: state.interview.sessionID,
    idea: state.interview.idea,
    mode: state.mode,
    summary: state.summary,
    title: state.interview.idea,
    questions: state.questions.map((q) => ({
      id: q.id,
      question: q.question,
      options: q.options,
      suggested: q.suggested,
    })),
    pendingAnswers: null,
    lastUpdatedAt: Date.now(),
    filePath: state.interview.markdownPath,
    nudgeAction: null,
  };
}

async function pushStateViaHttp(
  dashboardUrl: string,
  token: string,
  interviewId: string,
  state: InterviewState,
): Promise<void> {
  const entry = stateToEntry(interviewId, state);
  await fetch(
    `${dashboardUrl}/api/interviews/${interviewId}/state?token=${token}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(5000),
    },
  );
}

async function registerInterviewViaHttp(
  dashboardUrl: string,
  token: string,
  interview: InterviewRecord,
): Promise<void> {
  await fetch(`${dashboardUrl}/api/interviews?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      interviewId: interview.id,
      sessionID: interview.sessionID,
      idea: interview.idea,
    }),
    signal: AbortSignal.timeout(3000),
  });
}
