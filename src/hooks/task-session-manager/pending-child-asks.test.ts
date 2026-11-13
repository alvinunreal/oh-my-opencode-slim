import { afterEach, expect, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { boardFixture } from '../../utils/background-job-fixture';
import {
  observePendingChildAsks,
  type PendingChildAsks,
  routeChildInputWait,
} from './event-router';

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function setup() {
  const backgroundJobBoard = new BackgroundJobBoard();
  const pendingChildAsks: PendingChildAsks = new Map();
  const dispose = observePendingChildAsks(backgroundJobBoard, pendingChildAsks);
  disposers.push(dispose);
  const launch = (taskID: string) =>
    backgroundJobBoard.registerLaunch({
      taskID,
      parentSessionID: 'parent',
      agent: 'fixer',
      background: false,
    });
  const ask = (taskID: string, type: string, id: string) =>
    routeChildInputWait(
      { event: { type, properties: { sessionID: taskID, id } } },
      { backgroundJobBoard, pendingChildAsks },
    );
  return { backgroundJobBoard, pendingChildAsks, launch, ask, dispose };
}

test('a terminal generation releases its buffered question and permission', () => {
  // Mutation: retain asks when their generation becomes terminal.
  const h = setup();
  h.launch('child');
  h.launch('other');
  h.ask('child', 'question.asked', 'q1');
  h.ask('child', 'permission.asked', 'p1');
  h.ask('other', 'question.asked', 'q2');
  expect(h.pendingChildAsks.get('child')?.size).toBe(2);
  boardFixture.markCancelled(h.backgroundJobBoard, 'child', 'interrupted');
  expect(h.pendingChildAsks.has('child')).toBe(false);
  expect(h.pendingChildAsks.get('other')?.has('q2')).toBe(true);
});

test('a dropped running generation releases its buffered ask', () => {
  // Mutation: only prune terminal records, not removed records.
  const h = setup();
  h.launch('child');
  h.ask('child', 'permission.asked', 'p1');
  expect(h.pendingChildAsks.has('child')).toBe(true);
  h.backgroundJobBoard.drop('child');
  expect(h.pendingChildAsks.has('child')).toBe(false);
});

test('a new generation discards old asks without losing its own', () => {
  // Mutation: ignore generation changes or apply stale terminal evidence to a new run.
  const h = setup();
  const first = h.launch('child');
  h.ask('child', 'question.asked', 'old');
  h.launch('child');
  expect(h.pendingChildAsks.has('child')).toBe(false);
  h.ask('child', 'question.asked', 'new');
  boardFixture.markCancelled(h.backgroundJobBoard, 'child', 'old', undefined, {
    expectedGeneration: first.generation,
  });
  expect(h.pendingChildAsks.get('child')?.has('new')).toBe(true);
});

test('disposing the observer removes its board listener', () => {
  // Mutation: leave the mutation listener registered after disposal.
  const h = setup();
  h.launch('child');
  h.ask('child', 'question.asked', 'q1');
  h.dispose();
  h.backgroundJobBoard.drop('child');
  expect(h.pendingChildAsks.has('child')).toBe(true);
});
