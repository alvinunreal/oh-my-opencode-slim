import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { InterviewSessionRuntime } from './runtime';
import { createInterviewService } from './service';
import type { InterviewMessage } from './types';

describe('interview finalization', () => {
  test('persists clean completion markdown without using stale interview state', async () => {
    const directory = await fs.mkdtemp('/tmp/interview-finalization-');
    const messages: InterviewMessage[] = [];
    const continued: string[] = [];
    const runtime: InterviewSessionRuntime = {
      messages: async () => messages,
      create: async () => 'side-final',
      notify: async () => {},
      continue: async (_sessionID, text) => {
        continued.push(text);
      },
      rename: async () => {},
    };
    const service = createInterviewService({ directory } as never, undefined, {
      runtime,
      openBrowser: () => {},
    });
    service.setBaseUrlResolver(async () => 'http://127.0.0.1:43211');

    await service.handleCommandExecuteBefore(
      { command: 'interview', sessionID: 'ses_final', arguments: 'Final app' },
      { parts: [] },
    );
    const interviewID = service.getActiveInterviewId('ses_final');
    expect(interviewID).not.toBeNull();

    messages.push({
      info: { role: 'assistant' },
      parts: [
        {
          type: 'text',
          text: '<interview_state>{"summary":"Draft","questions":[{"id":"q-1","question":"Platform?","options":["Web"]}]}</interview_state>',
        },
      ],
    });
    await service.getInterviewState(interviewID as string);
    await service.submitAnswers(interviewID as string, [
      { questionId: 'q-1', answer: 'Web' },
    ]);
    await service.submitState('ses_final', {
      summary: 'Draft',
      patch: '',
      questions: [],
    });
    await service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses_final', status: { type: 'idle' } },
      },
    });
    await service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses_final', status: { type: 'idle' } },
      },
    });
    await service.handleNudgeAction(interviewID as string, 'confirm-complete');

    const state = await service.getInterviewState(interviewID as string);
    const document = await fs.readFile(
      path.join(directory, state.markdownPath),
      'utf8',
    );

    expect(document).toContain('Draft');
    expect(document).toContain('status: complete');
    expect(document).toContain('sessionID: ses_final');
    expect(document).toContain('Q: Platform?');
    expect(document).toContain('A: Web');
    expect(document).not.toContain('A polished final specification.');
    expect(document).not.toContain('<interview_state>');
    expect(continued.some((text) => text.includes('Produce a final'))).toBe(
      false,
    );
    expect(
      continued.some((text) => text.includes('finishing the interview')),
    ).toBe(false);

    await fs.rm(directory, { recursive: true, force: true });
  });

  test('isolates concurrent interviews with the same slug through finalization', async () => {
    const directory = await fs.mkdtemp('/tmp/interview-collision-');
    const scenarios = await Promise.all(
      ['alpha', 'beta'].map(async (label) => {
        const messages: InterviewMessage[] = [];
        const runtime: InterviewSessionRuntime = {
          messages: async () => messages,
          create: async () => `side-${label}`,
          notify: async () => {},
          continue: async () => {},
          rename: async () => {},
        };
        const service = createInterviewService(
          { directory } as never,
          undefined,
          {
            runtime,
            openBrowser: () => {},
          },
        );
        service.setBaseUrlResolver(async () => 'http://127.0.0.1:43211');

        await service.handleCommandExecuteBefore(
          {
            command: 'interview',
            sessionID: `ses_${label}`,
            arguments: 'Same Slug Product',
          },
          { parts: [] },
        );

        return { label, messages, service, sessionID: `ses_${label}` };
      }),
    );

    const records = scenarios.map((scenario) => {
      const interviewID = scenario.service.getActiveInterviewId(
        scenario.sessionID,
      );
      expect(interviewID).not.toBeNull();
      return { ...scenario, interviewID: interviewID as string };
    });

    await Promise.all(
      records.map(async ({ label, messages, service, interviewID }) => {
        messages.push({
          info: { role: 'assistant' },
          parts: [
            {
              type: 'text',
              text: `<interview_state>{"summary":"${label} draft","title":"Shared Product","questions":[{"id":"q-1","question":"${label} question?","options":["Yes"]}]}</interview_state>`,
            },
          ],
        });
        await service.getInterviewState(interviewID);
        await service.submitAnswers(interviewID, [
          { questionId: 'q-1', answer: `${label} answer` },
        ]);
        await service.submitState(`ses_${label}`, {
          summary: `${label} draft`,
          patch: '',
          questions: [],
        });
        await service.handleEvent({
          event: {
            type: 'session.status',
            properties: {
              sessionID: `ses_${label}`,
              status: { type: 'idle' },
            },
          },
        });
        await service.handleEvent({
          event: {
            type: 'session.status',
            properties: {
              sessionID: `ses_${label}`,
              status: { type: 'idle' },
            },
          },
        });
        await service.handleNudgeAction(interviewID, 'confirm-complete');
      }),
    );

    const states = await Promise.all(
      records.map(({ service, interviewID }) =>
        service.getInterviewState(interviewID),
      ),
    );
    const paths = states.map((state) =>
      path.join(directory, state.markdownPath),
    );

    expect(paths[0]).not.toBe(paths[1]);
    expect(path.basename(paths[0])).toMatch(
      /^same-slug-product-[0-9a-f-]+\.md$/,
    );
    expect(path.basename(paths[1])).toMatch(
      /^same-slug-product-[0-9a-f-]+\.md$/,
    );

    const documents = await Promise.all(
      paths.map((documentPath) => fs.readFile(documentPath, 'utf8')),
    );
    expect(documents[0]).toContain('alpha draft');
    expect(documents[0]).toContain('status: complete');
    expect(documents[0]).toContain('A: alpha answer');
    expect(documents[0]).not.toContain('alpha final specification.');
    expect(documents[0]).not.toContain('beta');
    expect(documents[1]).toContain('beta draft');
    expect(documents[1]).toContain('status: complete');
    expect(documents[1]).toContain('A: beta answer');
    expect(documents[1]).not.toContain('beta final specification.');
    expect(documents[1]).not.toContain('alpha');

    await fs.rm(directory, { recursive: true, force: true });
  });

  test('concurrent confirm-complete clicks publish one completion notice', async () => {
    const directory = await fs.mkdtemp('/tmp/interview-finalization-race-');
    const messages: InterviewMessage[] = [
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Draft' }] },
    ];
    const notices: string[] = [];
    const service = createInterviewService({ directory } as never, undefined, {
      runtime: {
        messages: async () => messages,
        create: async () => 'side-race',
        notify: async (_sessionID, text) => notices.push(text),
        continue: async () => {},
        rename: async () => {},
      },
      openBrowser: () => {},
    });
    service.setBaseUrlResolver(async () => 'http://127.0.0.1:43211');
    await service.handleCommandExecuteBefore(
      { command: 'interview', sessionID: 'ses-race', arguments: 'Race app' },
      { parts: [] },
    );
    const interviewID = service.getActiveInterviewId('ses-race');
    expect(interviewID).not.toBeNull();

    await Promise.all([
      service.handleNudgeAction(interviewID as string, 'confirm-complete'),
      service.handleNudgeAction(interviewID as string, 'confirm-complete'),
    ]);

    expect(
      notices.filter((notice) => notice.includes('spec is complete')),
    ).toHaveLength(1);
    const state = await service.getInterviewState(interviewID as string);
    expect(state.document.match(/status: complete/g)).toHaveLength(1);
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('prevents a second session from resuming the owned document', async () => {
    const directory = await fs.mkdtemp('/tmp/interview-resume-lock-');
    const documentPath = path.join(directory, 'interview', 'shared.md');
    await fs.mkdir(path.dirname(documentPath), { recursive: true });
    await fs.writeFile(
      documentPath,
      '# Shared document\n\n## Current spec\n\nDraft.\n\n## Q&A history\n\nNo answers yet.\n',
      'utf8',
    );

    const firstMessages: InterviewMessage[] = [];
    const firstService = createInterviewService(
      { directory } as never,
      undefined,
      {
        runtime: {
          messages: async () => firstMessages,
          create: async () => 'side-one',
          notify: async () => {},
          continue: async () => {},
          rename: async () => {},
        },
        openBrowser: () => {},
      },
    );
    firstService.setBaseUrlResolver(async () => 'http://127.0.0.1:43211');
    await firstService.handleCommandExecuteBefore(
      {
        command: 'interview',
        sessionID: 'ses_one',
        arguments: documentPath,
      },
      { parts: [] },
    );
    firstMessages.push({
      info: { role: 'assistant' },
      parts: [
        {
          type: 'text',
          text: '<interview_state>{"summary":"One draft","title":"Shared Title","questions":[{"id":"q-one","question":"One?","options":["Yes"]}]}</interview_state>',
        },
      ],
    });
    const firstInterviewID = firstService.getActiveInterviewId('ses_one');
    expect(firstInterviewID).not.toBeNull();
    await firstService.getInterviewState(firstInterviewID as string);
    const ownedDocument = await fs.readFile(documentPath, 'utf8');

    const secondService = createInterviewService(
      { directory } as never,
      undefined,
      {
        runtime: {
          messages: async () => [],
          create: async () => 'side-two',
          notify: async () => {},
          continue: async () => {},
          rename: async () => {},
        },
        openBrowser: () => {},
      },
    );
    secondService.setBaseUrlResolver(async () => 'http://127.0.0.1:43211');
    const secondOutput = {
      parts: [] as Array<{ type: string; text?: string }>,
    };
    await secondService.handleCommandExecuteBefore(
      {
        command: 'interview',
        sessionID: 'ses_two',
        arguments: documentPath,
      },
      secondOutput,
    );

    expect(secondService.getActiveInterviewId('ses_two')).toBeNull();
    expect(secondOutput.parts[0]?.text).toContain('already owned');
    expect(await fs.readFile(documentPath, 'utf8')).toBe(ownedDocument);
    expect(await fs.readdir(path.dirname(documentPath))).toEqual(['shared.md']);

    await fs.rm(directory, { recursive: true, force: true });
  });

  test('allows the owning session to resume through another service instance', async () => {
    const directory = await fs.mkdtemp('/tmp/interview-owner-resume-');
    const documentPath = path.join(directory, 'interview', 'owned.md');
    await fs.mkdir(path.dirname(documentPath), { recursive: true });
    await fs.writeFile(documentPath, '# Owned\n\nDraft.', 'utf8');

    const createService = () =>
      createInterviewService({ directory } as never, undefined, {
        runtime: {
          messages: async () => [],
          create: async () => 'side-owner',
          notify: async () => {},
          continue: async () => {},
          rename: async () => {},
        },
        openBrowser: () => {},
      });
    const firstService = createService();
    const secondService = createService();
    firstService.setBaseUrlResolver(async () => 'http://127.0.0.1:43211');
    secondService.setBaseUrlResolver(async () => 'http://127.0.0.1:43211');

    await firstService.handleCommandExecuteBefore(
      {
        command: 'interview',
        sessionID: 'same-session',
        arguments: documentPath,
      },
      { parts: [] },
    );
    await secondService.handleCommandExecuteBefore(
      {
        command: 'interview',
        sessionID: 'same-session',
        arguments: documentPath,
      },
      { parts: [] },
    );

    expect(secondService.getActiveInterviewId('same-session')).not.toBeNull();
    expect(await fs.readFile(documentPath, 'utf8')).toContain(
      'sessionID: same-session',
    );

    await fs.rm(directory, { recursive: true, force: true });
  });
});
