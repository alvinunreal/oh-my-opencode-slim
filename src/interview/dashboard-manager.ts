import type { Server } from 'node:http';
import path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import type { PluginConfig } from '../config';
import { log } from '../utils';
import { getClient } from '../utils/opencode-client';
import {
  type DashboardConfig,
  probeDashboard,
  readDashboardAuthFile,
  tryBecomeDashboard,
} from './dashboard';
import { interviewOwnerSessionID } from './document';
import type { InterviewSessionRuntime } from './runtime';
import { createInterviewServer, createInterviewServerDeps } from './server';
import { createInterviewService } from './service';
import type {
  InterviewAnswer,
  InterviewRecord,
  InterviewState,
  InterviewStateEntry,
} from './types';

export function createDashboardManager(
  ctx: PluginInput,
  config: PluginConfig,
  dashboardPort: number,
  outputFolder: string,
  options: {
    runtime?: InterviewSessionRuntime;
    sessionClient?: DashboardConfig['sessionClient'];
    /** Already-listening server for the dashboard role to adopt. */
    server?: Server;
    hostFlavor?: DashboardConfig['hostFlavor'];
  } = {},
): {
  service: ReturnType<typeof createInterviewService>;
  registerCommand: (
    config: Record<string, unknown>,
    enabled?: { interview?: boolean; implement?: boolean },
  ) => void;
  handleCommandExecuteBefore: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>;
  handleEvent: (input: {
    event: { type: string; properties?: Record<string, unknown> };
  }) => Promise<void>;
  dispose: () => Promise<void>;
} {
  const interviewConfig = config.interview;
  const service = createInterviewService(
    ctx,
    interviewConfig,
    options.runtime ? { runtime: options.runtime } : undefined,
  );

  // Async init - resolves once we know our role (dashboard or session)
  let initDone = false;
  let isDashboard = false;
  let dashboardBaseUrl = '';
  let authToken = '';
  let dashboard: Awaited<ReturnType<typeof tryBecomeDashboard>> | null = null;
  let fallbackServer: ReturnType<typeof createInterviewServer> | null = null;
  const registeredSessions = new Set<string>();
  let disposed = false;

  type HttpDeliveryKind = 'pending' | 'nudge' | 'block-comment' | 'chat';
  type PendingAck = {
    interviewId: string;
    kind: HttpDeliveryKind;
    claimId: string;
  };
  const pendingAcks = new Map<string, PendingAck>();
  const inFlightDeliveries = new Set<string>();
  const nonRedeliverableClaims = new Set<string>();
  type InProcessKind = 'answers' | 'nudge' | 'block-comment' | 'chat';
  const pendingInProcessAcks = new Map<
    string,
    { interviewId: string; kind: InProcessKind; claimId: string }
  >();
  const nonRedeliverableInProcessClaims = new Set<string>();
  const inFlightInProcessClaims = new Map<string, symbol>();
  const activeInProcessEvents = new Set<Promise<void>>();

  function acquireInProcessClaim(claimId: string): symbol | null {
    if (
      nonRedeliverableInProcessClaims.has(claimId) ||
      inFlightInProcessClaims.has(claimId)
    ) {
      return null;
    }

    const owner = Symbol(claimId);
    inFlightInProcessClaims.set(claimId, owner);
    return owner;
  }

  function releaseInProcessClaim(claimId: string, owner: symbol): void {
    if (inFlightInProcessClaims.get(claimId) === owner) {
      inFlightInProcessClaims.delete(claimId);
    }
  }

  function retryInProcessAcks(interviewId: string, kind: InProcessKind): void {
    if (!dashboard) return;
    for (const [claimId, pendingAck] of pendingInProcessAcks) {
      if (pendingAck.interviewId !== interviewId || pendingAck.kind !== kind) {
        continue;
      }
      if (dashboard.acknowledgePending(interviewId, kind, claimId)) {
        pendingInProcessAcks.delete(claimId);
      }
    }
  }

  function rememberInProcessAck(
    interviewId: string,
    kind: InProcessKind,
    claimId: string,
  ): void {
    pendingInProcessAcks.set(claimId, {
      interviewId,
      kind,
      claimId,
    });
    nonRedeliverableInProcessClaims.add(claimId);
  }

  async function retryPendingAck(claimId: string): Promise<boolean> {
    const pendingAck = pendingAcks.get(claimId);
    if (!pendingAck) return true;

    try {
      await settleHttpDelivery(
        dashboardBaseUrl,
        authToken,
        pendingAck.interviewId,
        pendingAck.kind,
        pendingAck.claimId,
        'ack',
      );
      pendingAcks.delete(claimId);
      return true;
    } catch (error) {
      // A 409 means the dashboard already accepted this claim but the
      // previous response was lost.  It is still non-redeliverable locally.
      if (error instanceof DeliverySettlementError && error.status === 409) {
        pendingAcks.delete(claimId);
        nonRedeliverableClaims.add(claimId);
        return false;
      }
      return false;
    }
  }

  async function deliverHttpClaim(
    interviewId: string,
    kind: HttpDeliveryKind,
    claimId: string,
    deliver: () => Promise<void>,
  ): Promise<void> {
    if (
      nonRedeliverableClaims.has(claimId) ||
      inFlightDeliveries.has(claimId)
    ) {
      return;
    }

    inFlightDeliveries.add(claimId);
    try {
      try {
        await deliver();
      } catch (error) {
        await settleHttpDelivery(
          dashboardBaseUrl,
          authToken,
          interviewId,
          kind,
          claimId,
          'rollback',
        );
        throw error;
      }

      try {
        await settleHttpDelivery(
          dashboardBaseUrl,
          authToken,
          interviewId,
          kind,
          claimId,
          'ack',
        );
      } catch (error) {
        // Delivery already happened.  Never roll the claim back here: doing
        // so would allow a later poll to deliver the same user input again.
        pendingAcks.set(claimId, { interviewId, kind, claimId });
        nonRedeliverableClaims.add(claimId);
        throw error;
      }
    } finally {
      inFlightDeliveries.delete(claimId);
    }
  }

  async function retryPendingAcks(
    interviewId: string,
    kind: HttpDeliveryKind,
  ): Promise<void> {
    const claims = [...pendingAcks.values()].filter(
      (pendingAck) =>
        pendingAck.interviewId === interviewId && pendingAck.kind === kind,
    );
    await Promise.all(claims.map((claim) => retryPendingAck(claim.claimId)));
  }

  // ── Timer-based fallback for nudge/answer polling ─────────────
  const FALLBACK_POLL_INTERVAL = 10_000;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  const stopFallbackTimer = () => {
    if (!fallbackTimer) return;
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  };
  const startFallbackTimer = () => {
    if (fallbackTimer) return;
    fallbackTimer = setInterval(() => {
      if (disposed || isDashboard || !dashboardBaseUrl) return;
      for (const sessionID of registeredSessions) {
        const interviewId = service.getActiveInterviewId(sessionID);
        if (!interviewId) continue;
        pollQueues(sessionID).catch(() => {});
      }
    }, FALLBACK_POLL_INTERVAL);
    fallbackTimer?.unref();
  };

  const initPromise = (async () => {
    try {
      dashboard = await tryBecomeDashboard({
        port: dashboardPort,
        outputFolder,
        hostFlavor: options.hostFlavor,
        sessionClient: options.sessionClient ?? getClient(ctx).session,
        server: options.server,
        onQueued: (interviewId) => {
          const sessionID = dashboard?.getState(interviewId)?.sessionID;
          if (
            disposed ||
            !sessionID ||
            service.getActiveInterviewId(sessionID) !== interviewId ||
            !service.isSessionIdle(sessionID)
          )
            return;
          const delivery = deliverInProcess(interviewId).catch((error) => {
            log('[interview] in-process delivery failed', {
              error: String(error),
            });
          });
          activeInProcessEvents.add(delivery);
          void delivery.finally(() => activeInProcessEvents.delete(delivery));
        },
      });

      if (dashboard) {
        // ── We ARE the dashboard ────────────────────────────────────
        isDashboard = true;
        dashboardBaseUrl = `http://127.0.0.1:${dashboardPort}`;
        authToken = dashboard.authToken;

        service.setBaseUrlResolver(() => Promise.resolve(dashboardBaseUrl));

        // State push: in-process, directly into dashboard cache
        service.setStatePushCallback((id, state) => {
          if (disposed) return;
          dashboard?.pushState(stateToEntry(id, state));
        });

        // Interview created: register in dashboard cache immediately
        service.setOnInterviewCreated((interview) => {
          if (disposed) return;
          dashboard?.pushState({
            interviewId: interview.id,
            sessionID: interviewOwnerSessionID(interview),
            idea: interview.idea,
            mode: 'awaiting-agent',
            summary: 'Interview created.',
            title: interview.idea,
            questions: [],
            pendingAnswers: null,
            lastUpdatedAt: Date.now(),
            filePath: interview.markdownPath,
            nudgeAction: null,
            pendingBlockComment: null,
            pendingChatMessage: null,
          });
          // Register session directory for file scanning
          dashboard?.registerSession({
            sessionID: interviewOwnerSessionID(interview),
            directory: ctx.directory,
            outputFolder,
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
          outputFolder,
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
          // Brief retry - dashboard may still be starting
          await new Promise((r) => setTimeout(r, 500));
          const retry = await probeDashboard(dashboardPort);
          if (!retry.alive) {
            log(
              '[interview] dashboard probe failed twice, falling back to local server',
            );
            throw new Error('Dashboard not reachable');
          }
        }

        const creds = await readDashboardAuthFile(dashboardPort);
        if (!creds) {
          throw new Error('Dashboard credentials file missing');
        }

        dashboardBaseUrl = `http://127.0.0.1:${dashboardPort}`;
        authToken = creds.token;

        service.setBaseUrlResolver(() => Promise.resolve(dashboardBaseUrl));

        // State push: across HTTP to the dashboard process
        service.setStatePushCallback((id, state) => {
          if (disposed) return;
          if (dashboardBaseUrl && authToken) {
            pushStateViaHttp(dashboardBaseUrl, authToken, id, state).catch(
              (err) => {
                log('[interview] failed to push state to dashboard:', {
                  error: err instanceof Error ? err.message : String(err),
                });
              },
            );
          }
        });

        // Interview created: POST to dashboard so it appears immediately
        service.setOnInterviewCreated((interview) => {
          if (disposed) return;
          if (dashboardBaseUrl && authToken) {
            registerInterviewViaHttp(
              dashboardBaseUrl,
              authToken,
              interview,
            ).catch((err) => {
              log('[interview] failed to register interview with dashboard:', {
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        });

        log('[interview] dashboard mode: registered as session client', {
          dashboardUrl: dashboardBaseUrl,
        });
      }
    } catch (err) {
      log(
        '[interview] dashboard election failed or unreachable. Falling back to per-session server.',
        { error: err instanceof Error ? err.message : String(err) },
      );
      // Fallback: wire up a local per-session server for the manager's
      // service, exactly like the non-dashboard mode would.
      isDashboard = false;
      const resolvedOutputPath = path.join(ctx.directory, outputFolder);
      fallbackServer = createInterviewServer(
        createInterviewServerDeps(service, resolvedOutputPath, 0),
      );
      service.setBaseUrlResolver(
        () =>
          fallbackServer?.ensureStarted() ??
          Promise.reject(new Error('Interview manager is disposed.')),
      );
      service.setStatePushCallback(() => {}); // no-op on fallback
    } finally {
      initDone = true;
    }
  })();

  async function ensureInitialized() {
    if (!initDone) {
      await initPromise;
    }
  }

  let disposePromise: Promise<void> | null = null;

  async function waitForActiveInProcessEvents(): Promise<void> {
    while (activeInProcessEvents.size > 0) {
      await Promise.all([...activeInProcessEvents]);
    }
  }

  function dispose(): Promise<void> {
    if (disposePromise) return disposePromise;

    disposed = true;
    stopFallbackTimer();
    const sessionsToUnregister = [...registeredSessions];
    registeredSessions.clear();
    pendingAcks.clear();
    service.setStatePushCallback(() => {});
    service.setOnInterviewCreated(() => {});

    disposePromise = (async () => {
      await initPromise;
      await waitForActiveInProcessEvents();
      pendingInProcessAcks.clear();
      inFlightDeliveries.clear();
      inFlightInProcessClaims.clear();
      nonRedeliverableClaims.clear();
      nonRedeliverableInProcessClaims.clear();
      stopFallbackTimer();
      if (!isDashboard && dashboardBaseUrl && authToken) {
        await Promise.all(
          sessionsToUnregister.map((sessionID) =>
            unregisterSessionViaHttp(
              dashboardBaseUrl,
              authToken,
              sessionID,
            ).catch(() => {}),
          ),
        );
      }
      if (isDashboard && dashboard) {
        for (const sessionID of sessionsToUnregister) {
          dashboard.removeSession(sessionID);
        }
      }
      dashboard?.close();
      dashboard = null;
      fallbackServer?.close();
      fallbackServer = null;
    })();
    return disposePromise;
  }

  type DeliveryPayload = {
    claimId?: string | null;
    answers?: InterviewAnswer[] | null;
    action?: 'more-questions' | 'confirm-complete' | null;
    section?: string;
    comment?: string;
    message?: string | null;
  };
  const queues: Array<{
    kind: InProcessKind;
    endpoint: HttpDeliveryKind;
    claim: (interviewId: string) => DeliveryPayload | null | undefined;
    prepare: (
      interviewId: string,
      payload: DeliveryPayload,
    ) => (() => Promise<void>) | undefined;
  }> = [
    {
      kind: 'answers',
      endpoint: 'pending',
      claim: (id) => dashboard?.claimPendingAnswers(id),
      prepare: (id, { answers }) =>
        answers ? () => service.submitAnswers(id, answers) : undefined,
    },
    {
      kind: 'nudge',
      endpoint: 'nudge',
      claim: (id) => dashboard?.claimNudgeAction(id),
      prepare: (id, { action }) =>
        action ? () => service.handleNudgeAction(id, action) : undefined,
    },
    {
      kind: 'block-comment',
      endpoint: 'block-comment',
      claim: (id) => {
        const claim = dashboard?.claimBlockComment(id);
        return claim && { claimId: claim.claimId, ...claim.comment };
      },
      prepare: (id, { section, comment }) =>
        typeof section === 'string' && typeof comment === 'string'
          ? () => service.submitBlockComment(id, section, comment)
          : undefined,
    },
    {
      kind: 'chat',
      endpoint: 'chat',
      claim: (id) => dashboard?.claimChatMessage(id),
      prepare: (id, { message }) =>
        message ? () => service.submitChat(id, message) : undefined,
    },
  ];

  async function pollQueues(sessionID: string): Promise<void> {
    const interviewId = service.getActiveInterviewId(sessionID);
    if (!interviewId) return;
    for (const queue of queues) {
      await retryPendingAcks(interviewId, queue.endpoint);
      try {
        const response = await fetch(
          `${dashboardBaseUrl}/api/interviews/${interviewId}/${queue.endpoint}`,
          {
            headers: authHeaders(authToken),
            signal: AbortSignal.timeout(3000),
          },
        );
        const body = (await response.json()) as DeliveryPayload;
        const deliver = queue.prepare(interviewId, body);
        if (response.ok && body.claimId && deliver) {
          await deliverHttpClaim(
            interviewId,
            queue.endpoint,
            body.claimId,
            deliver,
          );
        }
      } catch (error) {
        log('[interview] failed polling dashboard queue', {
          kind: queue.endpoint,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async function deliverInProcess(interviewId: string): Promise<void> {
    const currentDashboard = dashboard;
    if (!currentDashboard) return;
    for (const queue of queues) {
      retryInProcessAcks(interviewId, queue.kind);
      const claim = queue.claim(interviewId);
      const deliver = claim && queue.prepare(interviewId, claim);
      if (!claim?.claimId || !deliver) continue;
      const owner = acquireInProcessClaim(claim.claimId);
      if (!owner) continue;
      try {
        await deliver();
        if (
          inFlightInProcessClaims.get(claim.claimId) === owner &&
          !currentDashboard.acknowledgePending(
            interviewId,
            queue.kind,
            claim.claimId,
          )
        ) {
          rememberInProcessAck(interviewId, queue.kind, claim.claimId);
          log('[interview] delivery acknowledgement failed', {
            interviewId,
            kind: queue.kind,
          });
        }
      } catch (error) {
        if (inFlightInProcessClaims.get(claim.claimId) === owner) {
          currentDashboard.rollbackPending(
            interviewId,
            queue.kind,
            claim.claimId,
          );
        }
        log('[interview] delivery rolled back', {
          kind: queue.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        releaseInProcessClaim(claim.claimId, owner);
      }
    }
  }

  return {
    service,
    registerCommand: (c, enabled) => service.registerCommand(c, enabled),
    handleCommandExecuteBefore: async (input, output) => {
      await ensureInitialized();
      if (disposed) return;

      // Register session so dashboard/fallback timers track it
      const sessionID = input.sessionID;
      registeredSessions.add(sessionID);

      if (!isDashboard && dashboardBaseUrl) {
        fetch(`${dashboardBaseUrl}/api/register`, {
          method: 'POST',
          headers: {
            ...authHeaders(authToken),
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            sessionID,
            directory: ctx.directory,
            outputFolder,
            pid: process.pid,
          }),
          signal: AbortSignal.timeout(3000),
        })
          .then((response) => {
            if (!response.ok) {
              throw new Error(
                `session registration failed (${response.status})`,
              );
            }
          })
          .catch((err) => {
            log('[interview] failed to register session with dashboard:', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        startFallbackTimer();
      }

      await service.handleCommandExecuteBefore(input, output);
    },
    handleEvent: async (input) => {
      let finishEvent!: () => void;
      const eventDone = new Promise<void>((resolve) => {
        finishEvent = resolve;
      });
      activeInProcessEvents.add(eventDone);

      try {
        await ensureInitialized();
        if (disposed) return;
        const { event } = input;
        const properties = event.properties ?? {};
        const info = properties.info;
        const sessionID =
          typeof info === 'object' &&
          info !== null &&
          'id' in info &&
          typeof info.id === 'string'
            ? info.id
            : typeof properties.sessionID === 'string'
              ? properties.sessionID
              : null;

        await service.handleEvent(input);

        // Event hook: Session is idle. Check for any pending user submissions
        // queued on the dashboard and deliver them to OpenCode.
        if (event.type === 'session.status' || event.type === 'session.idle') {
          const status = properties.status as { type?: string } | undefined;
          const isIdleEvent =
            event.type === 'session.idle' || status?.type === 'idle';
          if (sessionID && isIdleEvent) {
            const interviewId = service.getActiveInterviewId(sessionID);
            if (!isDashboard && dashboardBaseUrl) {
              await pollQueues(sessionID);
            } else if (
              interviewId &&
              dashboard &&
              service.isSessionIdle(sessionID)
            ) {
              await deliverInProcess(interviewId);
            }

            // Refresh state: calls getInterviewState → syncInterview →
            // onStateChange. Runs AFTER nudge/answer processing so
            // sessionBusy is accurate.
            if (interviewId) {
              const refresh = service
                .getInterviewState(interviewId)
                .then(() => {})
                .catch((err) => {
                  log('[interview] failed to refresh state', {
                    error: err instanceof Error ? err.message : String(err),
                  });
                });
              activeInProcessEvents.add(refresh);
              void refresh.finally(() => activeInProcessEvents.delete(refresh));
            }
          }
        }

        // Clean up when a session is deleted
        if (event.type === 'session.deleted' && sessionID) {
          registeredSessions.delete(sessionID);
          if (!isDashboard && registeredSessions.size === 0) {
            stopFallbackTimer();
          }
          if (dashboard) {
            dashboard.removeSession(sessionID);
          } else if (dashboardBaseUrl && authToken) {
            unregisterSessionViaHttp(
              dashboardBaseUrl,
              authToken,
              sessionID,
            ).catch((err) => {
              log('[interview] failed to unregister deleted session:', {
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        }
      } finally {
        finishEvent();
        activeInProcessEvents.delete(eventDone);
      }
    },
    dispose,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────

class DeliverySettlementError extends Error {
  constructor(
    readonly status: number,
    operation: 'ack' | 'rollback',
  ) {
    super(`delivery ${operation} failed (${status})`);
    this.name = 'DeliverySettlementError';
  }
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function stateToEntry(
  interviewId: string,
  state: InterviewState,
): InterviewStateEntry {
  return {
    interviewId,
    sessionID: interviewOwnerSessionID(state.interview),
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
    pendingBlockComment: null,
    pendingChatMessage: null,
    document: state.document,
    blocks: state.blocks,
  };
}

async function pushStateViaHttp(
  dashboardUrl: string,
  token: string,
  interviewId: string,
  state: InterviewState,
): Promise<void> {
  const entry = stateToEntry(interviewId, state);
  const response = await fetch(
    `${dashboardUrl}/api/interviews/${interviewId}/state`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(token),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...entry, blocks: undefined }),
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) {
    throw new Error(`state push failed (${response.status})`);
  }
}

async function registerInterviewViaHttp(
  dashboardUrl: string,
  token: string,
  interview: InterviewRecord,
): Promise<void> {
  const response = await fetch(`${dashboardUrl}/api/interviews`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      interviewId: interview.id,
      sessionID: interviewOwnerSessionID(interview),
      idea: interview.idea,
      mode: 'awaiting-agent',
      summary: 'Interview created.',
      title: interview.idea,
      questions: [],
      pendingAnswers: null,
      lastUpdatedAt: Date.now(),
      filePath: interview.markdownPath,
      nudgeAction: null,
      pendingBlockComment: null,
      pendingChatMessage: null,
    }),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) {
    throw new Error(`interview registration failed (${response.status})`);
  }
}

async function unregisterSessionViaHttp(
  dashboardUrl: string,
  token: string,
  sessionID: string,
): Promise<void> {
  const response = await fetch(`${dashboardUrl}/api/unregister`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sessionID }),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) {
    throw new Error(`session unregister failed (${response.status})`);
  }
}

async function settleHttpDelivery(
  dashboardUrl: string,
  token: string,
  interviewId: string,
  kind: 'pending' | 'nudge' | 'block-comment' | 'chat',
  claimId: string,
  operation: 'ack' | 'rollback',
): Promise<void> {
  const response = await fetch(
    `${dashboardUrl}/api/interviews/${interviewId}/${kind}/${operation}`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(token),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ claimId }),
      signal: AbortSignal.timeout(3000),
    },
  );
  if (!response.ok) {
    throw new DeliverySettlementError(response.status, operation);
  }
}
