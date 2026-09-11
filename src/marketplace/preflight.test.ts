import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeConfig } from '../config/runtime';
import { discoverOnDiskSkillNames, discoverPreflightMcps } from './preflight';
import { parseSkillFrontmatterName } from './skill-frontmatter';

const previousConfigHome = process.env.XDG_CONFIG_HOME;
const previousConfigContent = process.env.OPENCODE_CONFIG_CONTENT;
const previousTestHome = process.env.OPENCODE_TEST_HOME;

afterEach(() => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  if (previousConfigContent === undefined) {
    delete process.env.OPENCODE_CONFIG_CONTENT;
  } else process.env.OPENCODE_CONFIG_CONTENT = previousConfigContent;
  if (previousTestHome === undefined) delete process.env.OPENCODE_TEST_HOME;
  else process.env.OPENCODE_TEST_HOME = previousTestHome;
});

function writeSkillFile(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

describe('parseSkillFrontmatterName', () => {
  test('accepts quoted names and YAML comments', () => {
    expect(
      parseSkillFrontmatterName(`---
name: "quoted-skill"
description: Test skill. # comment
---

# body
`),
    ).toBe('quoted-skill');
  });

  test('accepts block scalar names', () => {
    expect(
      parseSkillFrontmatterName(`---
name: |-
  block-skill
description: Test skill.
---

# body
`),
    ).toBe('block-skill');
  });

  test('rejects non-string names', () => {
    expect(
      parseSkillFrontmatterName(`---
name: 123
description: Test skill.
---

# body
`),
    ).toBeUndefined();
  });

  test('rejects non-string descriptions', () => {
    expect(
      parseSkillFrontmatterName(`---
name: typed-skill
description: true
---

# body
`),
    ).toBeUndefined();
  });
});

describe('OpenCode preflight discovery parity', () => {
  test('JSONC wins over JSON in the same project directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-preflight-'));
    const configHome = join(root, 'config');
    const project = join(root, 'project');
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      mkdirSync(join(project, '.opencode'), { recursive: true });
      writeFileSync(
        join(project, '.opencode', 'opencode.json'),
        JSON.stringify({
          mcp: {
            'json-mcp': { type: 'remote', url: 'http://127.0.0.1/json' },
            'shared-mcp': { type: 'remote', url: 'http://127.0.0.1/json' },
          },
        }),
      );
      writeFileSync(
        join(project, '.opencode', 'opencode.jsonc'),
        `{
          // jsonc should win
          "mcp": {
            "jsonc-mcp": { "type": "remote", "url": "http://127.0.0.1/jsonc" },
            "shared-mcp": { "type": "remote", "url": "http://127.0.0.1/jsonc" }
          }
        }`,
      );
      RuntimeConfig.reset(project);
      const names = discoverPreflightMcps(
        RuntimeConfig.init(project, {}),
        project,
      );
      expect(names).toContain('jsonc-mcp');
      expect(names).toContain('json-mcp');
      expect(names).toContain('shared-mcp');
      expect(names).not.toContain('http://127.0.0.1/json');
      const projectRoot = mkdtempSync(join(tmpdir(), 'marketplace-root-'));
      writeFileSync(
        join(projectRoot, 'opencode.json'),
        JSON.stringify({
          mcp: {
            'root-json': { type: 'remote', url: 'http://127.0.0.1/json' },
          },
        }),
      );
      writeFileSync(
        join(projectRoot, 'opencode.jsonc'),
        `{
          "mcp": {
            "root-jsonc": { "type": "remote", "url": "http://127.0.0.1/jsonc" },
            "root-json": { "enabled": false }
          }
        }`,
      );
      RuntimeConfig.reset(projectRoot);
      const rootNames = discoverPreflightMcps(
        RuntimeConfig.init(projectRoot, {}),
        projectRoot,
      );
      expect(rootNames).toContain('root-jsonc');
      expect(rootNames).not.toContain('root-json');
      rmSync(projectRoot, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('parses OPENCODE_CONFIG_CONTENT as JSONC', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-preflight-'));
    try {
      process.env.XDG_CONFIG_HOME = join(root, 'config');
      process.env.OPENCODE_CONFIG_CONTENT = `{
        // comment
        "mcp": {
          "content-mcp": { "type": "remote", "url": "http://127.0.0.1/mcp", },
        }
      }`;
      RuntimeConfig.reset(root);
      expect(
        discoverPreflightMcps(RuntimeConfig.init(root, {}), root),
      ).toContain('content-mcp');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects MCP definitions that fail the host schema', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-preflight-'));
    const project = join(root, 'project');
    try {
      process.env.XDG_CONFIG_HOME = join(root, 'config');
      mkdirSync(join(project, '.opencode'), { recursive: true });
      writeFileSync(
        join(project, '.opencode', 'opencode.json'),
        JSON.stringify({
          mcp: {
            'timeout-mcp': {
              type: 'remote',
              url: 'http://127.0.0.1/mcp',
              timeout: 0,
            },
            'env-mcp': {
              type: 'local',
              command: ['npx', 'server'],
              environment: { TOKEN: 1 },
            },
            'header-mcp': {
              type: 'remote',
              url: 'http://127.0.0.1/mcp',
              headers: { Authorization: 1 },
            },
            'oauth-mcp': {
              type: 'remote',
              url: 'http://127.0.0.1/mcp',
              oauth: true,
            },
          },
        }),
      );
      RuntimeConfig.reset(project);
      const names = discoverPreflightMcps(
        RuntimeConfig.init(project, {}),
        project,
      );
      expect(names).not.toContain('timeout-mcp');
      expect(names).not.toContain('env-mcp');
      expect(names).not.toContain('header-mcp');
      expect(names).not.toContain('oauth-mcp');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('discovers YAML block-scalar skills and rejects typed frontmatter', () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-preflight-'));
    const skillRoot = join(root, 'skills');
    try {
      process.env.XDG_CONFIG_HOME = join(root, 'config');
      process.env.OPENCODE_TEST_HOME = root;
      writeSkillFile(
        join(skillRoot, 'block', 'SKILL.md'),
        `---
name: |-
  block-skill
description: Test skill.
---

# body
`,
      );
      writeSkillFile(
        join(skillRoot, 'bad-name', 'SKILL.md'),
        `---
name: 123
description: Test skill.
---

# body
`,
      );
      writeSkillFile(
        join(skillRoot, 'bad-desc', 'SKILL.md'),
        `---
name: desc-skill
description: ["not", "a", "string"]
---

# body
`,
      );
      expect(discoverOnDiskSkillNames(root, [skillRoot])).toEqual([
        'block-skill',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
