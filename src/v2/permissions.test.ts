import { describe, expect, test } from 'bun:test';
import { compilePermissionPolicy } from './permissions';
import type { V2PermissionRule } from './types';

const allowAll: V2PermissionRule[] = [
  { action: '*', resource: '*', effect: 'allow' },
];

function emittedDecision(
  rules: readonly V2PermissionRule[],
  action: string,
  resource: string,
): V2PermissionRule['effect'] {
  const match = rules.findLast(
    (rule) => matches(action, rule.action) && matches(resource, rule.resource),
  );
  return match?.effect ?? 'ask';
}

function matches(value: string, pattern: string): boolean {
  const normalizedPattern = pattern.replaceAll('\\', '/');
  const normalizedValue = value.replaceAll('\\', '/');
  const variants =
    normalizedPattern.endsWith(' *') && !normalizedPattern.endsWith(' **')
      ? [normalizedPattern.slice(0, -2), normalizedPattern]
      : [normalizedPattern];
  return variants.some((variant) => {
    const expression = variant
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${expression}$`, 's').test(normalizedValue);
  });
}

describe('compilePermissionPolicy', () => {
  test('uses last matching baseline and host rules in either order', () => {
    const denyAfterAllow = compilePermissionPolicy({
      baselineRules: allowAll,
      hostRules: [
        { action: 'read', resource: 'src/**', effect: 'allow' },
        { action: 'read', resource: 'src/private/**', effect: 'deny' },
      ],
    });
    expect(denyAfterAllow.decide('read', 'src/public.ts')).toBe('allow');
    expect(denyAfterAllow.decide('read', 'src/private/key.ts')).toBe('deny');

    const allowAfterDeny = compilePermissionPolicy({
      baselineRules: allowAll,
      hostRules: [
        { action: 'read', resource: 'src/**', effect: 'deny' },
        { action: 'read', resource: 'src/public.ts', effect: 'allow' },
      ],
    });
    expect(allowAfterDeny.decide('read', 'src/private.ts')).toBe('deny');
    expect(allowAfterDeny.decide('read', 'src/public.ts')).toBe('allow');
  });

  test('defaults to ask without ceilings and deny outside admitted scopes', () => {
    const open = compilePermissionPolicy({ baselineRules: [], hostRules: [] });
    expect(open.decide('read', 'file.ts')).toBe('ask');

    const limited = compilePermissionPolicy({
      baselineRules: [],
      hostRules: [],
      ceilings: { actions: { read: 'allow' }, namespaces: ['ctx_*'] },
    });
    expect(limited.decide('read', 'file.ts')).toBe('ask');
    expect(limited.decide('unknown', 'file.ts')).toBe('deny');
    expect(limited.decide('ctx_search', '*')).toBe('ask');
  });

  test('prevents rules from granting actions outside action and namespace ceilings', () => {
    const policy = compilePermissionPolicy({
      baselineRules: allowAll,
      hostRules: [
        { action: '*', resource: '*', effect: 'allow' },
        { action: 'ctx_*', resource: '*', effect: 'allow' },
      ],
      ceilings: {
        actions: { read: 'ask' },
        namespaces: ['ctx_*', 'ctx_private_*'],
        namespaceEffects: { 'ctx_*': 'deny' },
      },
    });
    expect(policy.decide('read', 'file.ts')).toBe('ask');
    expect(policy.decide('ctx_search', '*')).toBe('deny');
    expect(policy.decide('unadmitted_tool', '*')).toBe('deny');
  });

  test('resource ceilings remain restrictive after broad grants', () => {
    const policy = compilePermissionPolicy({
      baselineRules: allowAll,
      hostRules: [{ action: 'read', resource: '*', effect: 'allow' }],
      ceilings: {
        actions: { read: 'allow' },
        namespaces: [],
        resources: { read: { 'private/**': 'deny', 'review/*': 'ask' } },
      },
    });
    expect(policy.decide('read', 'public/file')).toBe('allow');
    expect(policy.decide('read', 'private/key')).toBe('deny');
    expect(policy.decide('read', 'review/file')).toBe('ask');
    expect(policy.decide('edit', 'private/key')).toBe('deny');
  });

  test('emitted rules preserve ceilings against namespace and resource grants', () => {
    const policy = compilePermissionPolicy({
      baselineRules: allowAll,
      hostRules: [
        { action: 'ctx_*', resource: '*', effect: 'allow' },
        { action: 'ctx_search', resource: '*', effect: 'deny' },
        { action: 'ctx_private_*', resource: '*', effect: 'deny' },
      ],
      ceilings: {
        actions: { ctx_search: 'allow', read: 'allow' },
        namespaces: ['ctx_*'],
        namespaceEffects: { 'ctx_*': 'allow', 'ctx_private_*': 'deny' },
        resources: { read: { '*': 'deny', 'private/**': 'deny' } },
      },
    });

    for (const [action, resource] of [
      ['ctx_search', 'anything'],
      ['ctx_private_lookup', 'anything'],
      ['ctx_public', 'anything'],
      ['read', 'anything'],
      ['read', 'private/key'],
      ['unadmitted', 'anything'],
    ]) {
      expect(emittedDecision(policy.rules, action, resource)).toBe(
        policy.decide(action, resource),
      );
    }
    expect(emittedDecision(policy.rules, 'ctx_search', 'anything')).toBe(
      'deny',
    );
    expect(emittedDecision(policy.rules, 'read', 'anything')).toBe('deny');
  });

  test('resource ask ceilings preserve baseline denies', () => {
    const policy = compilePermissionPolicy({
      baselineRules: [
        { action: 'read', resource: 'private/**', effect: 'deny' },
      ],
      hostRules: [],
      ceilings: {
        actions: { read: 'allow' },
        namespaces: [],
        resources: { read: { 'private/**': 'ask' } },
      },
    });
    expect(policy.decide('read', 'private/key')).toBe('deny');
    expect(emittedDecision(policy.rules, 'read', 'private/key')).toBe('deny');
  });

  test('final denials stay final when ceilings are present', () => {
    const policy = compilePermissionPolicy({
      baselineRules: allowAll,
      hostRules: [{ action: 'blocked', resource: '*', effect: 'allow' }],
      ceilings: { actions: { blocked: 'allow' }, namespaces: [] },
      finalDenials: ['blocked'],
    });
    expect(policy.decide('blocked', 'x')).toBe('deny');
    expect(emittedDecision(policy.rules, 'blocked', 'x')).toBe('deny');
  });

  test('resource ask ceilings cannot admit unadmitted actions', () => {
    const policy = compilePermissionPolicy({
      baselineRules: allowAll,
      hostRules: [],
      ceilings: {
        actions: {},
        namespaces: [],
        resources: { read: { 'private/**': 'ask' } },
      },
    });
    expect(policy.decide('read', 'private/key')).toBe('deny');
    expect(emittedDecision(policy.rules, 'read', 'private/key')).toBe('deny');
  });

  test('emitted namespace ceilings are order-independent', () => {
    const namespaceOrders = [
      ['ctx_*', 'ctx_private_*'],
      ['ctx_private_*', 'ctx_*'],
    ];
    const hostOrders = [
      [
        { action: 'ctx_private_*', resource: '*', effect: 'deny' as const },
        { action: 'ctx_*', resource: '*', effect: 'allow' as const },
      ],
      [
        { action: 'ctx_*', resource: '*', effect: 'allow' as const },
        { action: 'ctx_private_*', resource: '*', effect: 'deny' as const },
      ],
    ];

    for (const namespaces of namespaceOrders) {
      for (const hostRules of hostOrders) {
        const policy = compilePermissionPolicy({
          baselineRules: [],
          hostRules,
          ceilings: {
            actions: {},
            namespaces,
            namespaceEffects: {
              'ctx_*': 'allow',
              'ctx_private_*': 'deny',
            },
          },
        });
        for (const action of ['ctx_private_lookup', 'ctx_public']) {
          expect(emittedDecision(policy.rules, action, '*')).toBe(
            policy.decide(action, '*'),
          );
        }
      }
    }
  });

  test('clones and freezes emitted rules', () => {
    const source: V2PermissionRule = {
      action: 'read',
      resource: '*',
      effect: 'allow',
    };
    const policy = compilePermissionPolicy({
      baselineRules: [source],
      hostRules: [],
    });
    expect(Object.isFrozen(policy.rules)).toBe(true);
    expect(Object.isFrozen(policy.rules[0])).toBe(true);
    expect(policy.rules[0]).not.toBe(source);
  });

  test('applies a later source exception after earlier matching rules', () => {
    const policy = compilePermissionPolicy({
      baselineRules: [],
      hostRules: [
        { action: 'read', resource: '*', effect: 'allow' },
        { action: 'read', resource: 'private/*', effect: 'deny' },
        {
          action: 'read',
          resource: 'private/public.txt',
          effect: 'ask',
        },
      ],
      ceilings: { actions: { read: 'allow' }, namespaces: [] },
    });
    expect(policy.decide('read', 'public.txt')).toBe('allow');
    expect(policy.decide('read', 'private/secret.txt')).toBe('deny');
    expect(policy.decide('read', 'private/public.txt')).toBe('ask');
    expect(emittedDecision(policy.rules, 'read', 'private/public.txt')).toBe(
      'ask',
    );
  });

  test('later source denies are not resurrected by an earlier allow', () => {
    const policy = compilePermissionPolicy({
      baselineRules: [
        { action: 'read', resource: 'private/*', effect: 'allow' },
      ],
      hostRules: [{ action: 'read', resource: '*', effect: 'deny' }],
      ceilings: { actions: { read: 'allow' }, namespaces: [] },
    });
    expect(policy.decide('read', 'private/key')).toBe('deny');
  });

  test('intersects exact action and overlapping namespace ceilings', () => {
    const policy = compilePermissionPolicy({
      baselineRules: [{ action: '*', resource: '*', effect: 'allow' }],
      hostRules: [],
      ceilings: {
        actions: { ctx_private_lookup: 'ask' },
        namespaces: ['ctx_*', 'ctx_private_*'],
        namespaceEffects: { 'ctx_*': 'allow', 'ctx_private_*': 'deny' },
      },
    });
    expect(policy.decide('ctx_private_lookup', 'x')).toBe('deny');
    expect(policy.decide('ctx_public', 'x')).toBe('allow');
    expect(policy.decide('outside', 'x')).toBe('deny');
  });

  test('resource ceilings are scoped within each source rule block', () => {
    const policy = compilePermissionPolicy({
      baselineRules: [],
      hostRules: [
        { action: 'read', resource: '*', effect: 'allow' },
        { action: 'read', resource: 'private/*', effect: 'allow' },
      ],
      ceilings: {
        actions: { read: 'allow' },
        namespaces: [],
        resources: { read: { 'private/*': 'deny' } },
      },
    });
    expect(policy.decide('read', 'public/file')).toBe('allow');
    expect(policy.decide('read', 'private/file')).toBe('deny');
    expect(emittedDecision(policy.rules, 'read', 'private/file')).toBe('deny');
  });

  test('resource ceilings intersect exact and prefix scopes', () => {
    const policy = compilePermissionPolicy({
      baselineRules: [{ action: 'read', resource: '*', effect: 'allow' }],
      hostRules: [],
      ceilings: {
        actions: { read: 'allow' },
        namespaces: [],
        resources: {
          read: { 'private/*': 'deny', 'private/public.txt': 'ask' },
        },
      },
    });
    expect(policy.decide('read', 'private/secret.txt')).toBe('deny');
    expect(policy.decide('read', 'private/public.txt')).toBe('deny');
  });

  test('resource ask ceilings do not elevate a source denial', () => {
    const policy = compilePermissionPolicy({
      baselineRules: [],
      hostRules: [{ action: 'read', resource: 'private/*', effect: 'deny' }],
      ceilings: {
        actions: { read: 'allow' },
        namespaces: [],
        resources: { read: { 'private/*': 'ask' } },
      },
    });
    expect(policy.decide('read', 'private/key')).toBe('deny');
  });

  test('rejects unsupported ceiling patterns before emitting a policy', () => {
    expect(() =>
      compilePermissionPolicy({
        baselineRules: [],
        hostRules: [],
        ceilings: { actions: {}, namespaces: ['ctx_*_private'] },
      }),
    ).toThrow('Unsupported permission namespace ceiling pattern');
    expect(() =>
      compilePermissionPolicy({
        baselineRules: [],
        hostRules: [],
        ceilings: {
          actions: { read: 'allow' },
          namespaces: [],
          resources: { read: { 'private/**/key': 'deny' } },
        },
      }),
    ).toThrow('Unsupported permission resource ceiling pattern');
  });

  test('normalizes slashes and matches native wildcard edge cases', () => {
    const policy = compilePermissionPolicy({
      baselineRules: [
        { action: 'git *', resource: 'src\\?.ts', effect: 'allow' },
      ],
      hostRules: [],
    });
    expect(policy.decide('git commit', 'src/a.ts')).toBe('allow');
    expect(policy.decide('git', 'src/a.ts')).toBe('allow');
    expect(policy.decide('git commit', 'src\\a.ts')).toBe('allow');
  });

  test('intersects arbitrary source globs with resource-prefix ceilings', () => {
    const policy = compilePermissionPolicy({
      baselineRules: [{ action: 'read', resource: '*.txt', effect: 'allow' }],
      hostRules: [],
      ceilings: {
        actions: { read: 'allow' },
        namespaces: [],
        resources: { read: { 'private/*': 'deny' } },
      },
    });
    expect(policy.decide('read', 'private/key.txt')).toBe('deny');
    expect(emittedDecision(policy.rules, 'read', 'private/key.txt')).toBe(
      'deny',
    );
  });

  test('applies a git exact-resource ceiling to the native git wildcard', () => {
    const policy = compilePermissionPolicy({
      baselineRules: [
        { action: 'execute', resource: 'git *', effect: 'allow' },
      ],
      hostRules: [],
      ceilings: {
        actions: { execute: 'allow' },
        namespaces: [],
        resources: { execute: { git: 'deny' } },
      },
    });
    expect(policy.decide('execute', 'git')).toBe('deny');
    expect(emittedDecision(policy.rules, 'execute', 'git')).toBe('deny');
  });

  test('preserves the literal branch of git wildcard ceiling intersections', () => {
    const policy = compilePermissionPolicy({
      baselineRules: [{ action: 'execute', resource: '*', effect: 'allow' }],
      hostRules: [{ action: 'execute', resource: 'git?*', effect: 'deny' }],
      ceilings: {
        actions: { execute: 'allow' },
        namespaces: [],
        resources: { execute: { 'git *': 'ask' } },
      },
    });
    expect(policy.decide('execute', 'git')).toBe('ask');
    expect(emittedDecision(policy.rules, 'execute', 'git')).toBe('ask');
  });

  test('does not collapse repeated stars in arbitrary source rules', () => {
    const policy = compilePermissionPolicy({
      baselineRules: [],
      hostRules: [{ action: 'execute', resource: 'git **', effect: 'allow' }],
      ceilings: { actions: { execute: 'allow' }, namespaces: [] },
    });
    expect(policy.decide('execute', 'git')).toBe('ask');
    expect(emittedDecision(policy.rules, 'execute', 'git')).toBe('ask');
    expect(policy.decide('execute', 'git commit')).toBe('allow');
  });
});
