import { describe, expect, test } from 'bun:test';
import { SubagentDepthTracker } from './subagent-depth';

describe('SubagentDepthTracker', () => {
  describe('constructor', () => {
    test('uses DEFAULT_MAX_SUBAGENT_DEPTH (3) by default', () => {
      const tracker = new SubagentDepthTracker();
      expect(tracker).toBeDefined();
    });

    test('accepts custom max depth', () => {
      const tracker = new SubagentDepthTracker(5);
      expect(tracker).toBeDefined();
    });
  });

  describe('getDepth', () => {
    test('returns 0 for untracked sessions (root sessions)', () => {
      const tracker = new SubagentDepthTracker();
      expect(tracker.getDepth('root-session')).toBe(0);
      expect(tracker.getDepth('untracked-session')).toBe(0);
    });

    test('returns tracked depth for registered sessions', () => {
      const tracker = new SubagentDepthTracker();
      tracker.registerChild('root-session', 'child-session');
      expect(tracker.getDepth('child-session')).toBe(1);
    });
  });

  describe('registerChild', () => {
    test('tracks depth correctly (parent=0, child=1, grandchild=2)', () => {
      const tracker = new SubagentDepthTracker();

      expect(tracker.getDepth('root')).toBe(0);

      const allowed1 = tracker.registerChild('root', 'child1');
      expect(allowed1).toBe(true);
      expect(tracker.getDepth('child1')).toBe(1);

      const allowed2 = tracker.registerChild('child1', 'grandchild');
      expect(allowed2).toBe(true);
      expect(tracker.getDepth('grandchild')).toBe(2);
    });

    test('returns false when max depth exceeded (depth 4 > max 3)', () => {
      const tracker = new SubagentDepthTracker(3);

      const root = 'root';
      const child1 = 'child1';
      const child2 = 'child2';
      const child3 = 'child3';
      const child4 = 'child4';

      expect(tracker.registerChild(root, child1)).toBe(true);
      expect(tracker.registerChild(child1, child2)).toBe(true);
      expect(tracker.registerChild(child2, child3)).toBe(true);
      expect(tracker.registerChild(child3, child4)).toBe(false);
    });

    test('tracks across multiple branches independently', () => {
      const tracker = new SubagentDepthTracker();

      const root = 'root';
      const branch1Child = 'branch1-child';
      const branch2Child = 'branch2-child';
      const branch1Grandchild = 'branch1-grandchild';
      const branch2Grandchild = 'branch2-grandchild';

      tracker.registerChild(root, branch1Child);
      tracker.registerChild(branch1Child, branch1Grandchild);

      tracker.registerChild(root, branch2Child);
      tracker.registerChild(branch2Child, branch2Grandchild);

      expect(tracker.getDepth(branch1Child)).toBe(1);
      expect(tracker.getDepth(branch2Child)).toBe(1);
      expect(tracker.getDepth(branch1Grandchild)).toBe(2);
      expect(tracker.getDepth(branch2Grandchild)).toBe(2);
    });

    test('does not re-register existing session', () => {
      const tracker = new SubagentDepthTracker();

      const root = 'root';
      const child = 'child';

      tracker.registerChild(root, child);
      expect(tracker.getDepth(child)).toBe(1);

      tracker.registerChild(root, child);
      expect(tracker.getDepth(child)).toBe(1);
    });

    test('updates depth if child is re-registered from different parent', () => {
      const tracker = new SubagentDepthTracker();

      const root = 'root';
      const child1 = 'child1';
      const child2 = 'child2';
      const grandchild = 'grandchild';

      tracker.registerChild(root, child1);
      tracker.registerChild(child1, grandchild);
      expect(tracker.getDepth(grandchild)).toBe(2);

      tracker.registerChild(root, child2);
      tracker.registerChild(child2, grandchild);
      expect(tracker.getDepth(grandchild)).toBe(2);
    });
  });

  describe('cleanup', () => {
    test('removes a specific session', () => {
      const tracker = new SubagentDepthTracker();

      const root = 'root';
      const child1 = 'child1';
      const child2 = 'child2';

      tracker.registerChild(root, child1);
      tracker.registerChild(root, child2);

      expect(tracker.getDepth(child1)).toBe(1);
      expect(tracker.getDepth(child2)).toBe(1);

      tracker.cleanup(child1);

      expect(tracker.getDepth(child1)).toBe(0);
      expect(tracker.getDepth(child2)).toBe(1);
    });

    test('does not throw when cleaning up untracked session', () => {
      const tracker = new SubagentDepthTracker();

      expect(() => tracker.cleanup('untracked')).not.toThrow();
    });
  });

  describe('cleanupAll', () => {
    test('removes all sessions', () => {
      const tracker = new SubagentDepthTracker();

      const root = 'root';
      const child1 = 'child1';
      const child2 = 'child2';
      const grandchild = 'grandchild';

      tracker.registerChild(root, child1);
      tracker.registerChild(root, child2);
      tracker.registerChild(child1, grandchild);

      expect(tracker.getDepth(child1)).toBe(1);
      expect(tracker.getDepth(child2)).toBe(1);
      expect(tracker.getDepth(grandchild)).toBe(2);

      tracker.cleanupAll();

      expect(tracker.getDepth(child1)).toBe(0);
      expect(tracker.getDepth(child2)).toBe(0);
      expect(tracker.getDepth(grandchild)).toBe(0);
    });

    test('does not throw when called on empty tracker', () => {
      const tracker = new SubagentDepthTracker();

      expect(() => tracker.cleanupAll()).not.toThrow();
    });
  });
});
