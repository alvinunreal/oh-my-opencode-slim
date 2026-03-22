import { beforeEach, describe, expect, it } from 'bun:test';

describe('LSP Config Store', () => {
  let setUserLspConfig: (config: Record<string, unknown> | undefined) => void;
  let getUserLspConfig: (
    serverId: string,
  ) => import('./config-store').UserLspConfig | undefined;
  let getAllUserLspConfigs: () => Map<
    string,
    import('./config-store').UserLspConfig
  >;
  let hasUserLspConfig: () => boolean;

  beforeEach(async () => {
    // Import fresh module and clear state
    const module = await import('./config-store');
    setUserLspConfig = module.setUserLspConfig;
    getUserLspConfig = module.getUserLspConfig;
    getAllUserLspConfigs = module.getAllUserLspConfigs;
    hasUserLspConfig = module.hasUserLspConfig;
    setUserLspConfig(undefined);
  });

  describe('setUserLspConfig', () => {
    it('clears the store when called with undefined', () => {
      // First set some config
      setUserLspConfig({
        'typescript-language-server': {
          command: ['typescript-language-server', '--stdio'],
        },
      });

      expect(hasUserLspConfig()).toBe(true);

      // Clear with undefined
      setUserLspConfig(undefined);

      expect(hasUserLspConfig()).toBe(false);
    });

    it('clears the store when called with empty object', () => {
      // First set some config
      setUserLspConfig({
        'typescript-language-server': {
          command: ['typescript-language-server', '--stdio'],
        },
      });

      expect(hasUserLspConfig()).toBe(true);

      // Clear with empty object
      setUserLspConfig({});

      expect(hasUserLspConfig()).toBe(false);
    });

    it('sets multiple servers correctly', () => {
      const config = {
        'typescript-language-server': {
          command: ['typescript-language-server', '--stdio'],
          extensions: ['ts', 'tsx'],
        },
        'eslint-language-server': {
          command: ['vscode-eslint-language-server', '--stdio'],
          extensions: ['js', 'jsx'],
        },
      };

      setUserLspConfig(config);

      const tsConfig = getUserLspConfig('typescript-language-server');
      const eslintConfig = getUserLspConfig('eslint-language-server');

      expect(tsConfig).toBeDefined();
      expect(tsConfig?.id).toBe('typescript-language-server');
      expect(tsConfig?.command).toEqual([
        'typescript-language-server',
        '--stdio',
      ]);
      expect(tsConfig?.extensions).toEqual(['ts', 'tsx']);

      expect(eslintConfig).toBeDefined();
      expect(eslintConfig?.id).toBe('eslint-language-server');
      expect(eslintConfig?.command).toEqual([
        'vscode-eslint-language-server',
        '--stdio',
      ]);
      expect(eslintConfig?.extensions).toEqual(['js', 'jsx']);
    });

    it('handles all UserLspConfig fields', () => {
      const config = {
        'test-server': {
          command: ['test-server', '--stdio'],
          extensions: ['ts', 'js'],
          disabled: true,
          env: { NODE_ENV: 'test', DEBUG: 'true' },
          initialization: { maxNumberOfProblems: 100 },
        },
      };

      setUserLspConfig(config);

      const serverConfig = getUserLspConfig('test-server');

      expect(serverConfig).toBeDefined();
      expect(serverConfig?.id).toBe('test-server');
      expect(serverConfig?.command).toEqual(['test-server', '--stdio']);
      expect(serverConfig?.extensions).toEqual(['ts', 'js']);
      expect(serverConfig?.disabled).toBe(true);
      expect(serverConfig?.env).toEqual({ NODE_ENV: 'test', DEBUG: 'true' });
      expect(serverConfig?.initialization).toEqual({
        maxNumberOfProblems: 100,
      });
    });

    it('handles optional fields correctly', () => {
      const config = {
        'minimal-server': {
          command: ['minimal-server'],
        },
      };

      setUserLspConfig(config);

      const serverConfig = getUserLspConfig('minimal-server');

      expect(serverConfig).toBeDefined();
      expect(serverConfig?.id).toBe('minimal-server');
      expect(serverConfig?.command).toEqual(['minimal-server']);
      expect(serverConfig?.extensions).toBeUndefined();
      expect(serverConfig?.disabled).toBeUndefined();
      expect(serverConfig?.env).toBeUndefined();
      expect(serverConfig?.initialization).toBeUndefined();
    });

    it('ignores non-object entries', () => {
      const config = {
        'valid-server': {
          command: ['valid-server'],
        },
        'invalid-null': null,
        'invalid-string': 'not-an-object',
        'invalid-number': 123,
      };

      setUserLspConfig(config);

      expect(hasUserLspConfig()).toBe(true);
      expect(getUserLspConfig('valid-server')).toBeDefined();
      expect(getUserLspConfig('invalid-null')).toBeUndefined();
      expect(getUserLspConfig('invalid-string')).toBeUndefined();
      expect(getUserLspConfig('invalid-number')).toBeUndefined();
    });

    it('replaces existing config when called again', () => {
      // Set initial config
      setUserLspConfig({
        'old-server': {
          command: ['old-server'],
        },
      });

      expect(getAllUserLspConfigs().size).toBe(1);

      // Replace with new config
      setUserLspConfig({
        'new-server': {
          command: ['new-server'],
        },
      });

      expect(getAllUserLspConfigs().size).toBe(1);
      expect(getUserLspConfig('old-server')).toBeUndefined();
      expect(getUserLspConfig('new-server')).toBeDefined();
    });
  });

  describe('getUserLspConfig', () => {
    it('returns undefined for non-existent server', () => {
      const config = getUserLspConfig('non-existent-server');

      expect(config).toBeUndefined();
    });

    it('returns correct config for existing server', () => {
      const config = {
        'typescript-language-server': {
          command: ['typescript-language-server', '--stdio'],
          extensions: ['ts', 'tsx'],
          disabled: false,
          env: { NODE_ENV: 'production' },
          initialization: { maxNumberOfProblems: 100 },
        },
      };

      setUserLspConfig(config);

      const serverConfig = getUserLspConfig('typescript-language-server');

      expect(serverConfig).toBeDefined();
      expect(serverConfig?.id).toBe('typescript-language-server');
      expect(serverConfig?.command).toEqual([
        'typescript-language-server',
        '--stdio',
      ]);
      expect(serverConfig?.extensions).toEqual(['ts', 'tsx']);
      expect(serverConfig?.disabled).toBe(false);
      expect(serverConfig?.env).toEqual({ NODE_ENV: 'production' });
      expect(serverConfig?.initialization).toEqual({
        maxNumberOfProblems: 100,
      });
    });

    it('returns reference - mutation affects store', () => {
      const config = {
        'test-server': {
          command: ['test-server'],
          extensions: ['ts'],
          env: { KEY: 'value' },
          initialization: { setting: 'original' },
        },
      };

      setUserLspConfig(config);

      const serverConfig = getUserLspConfig('test-server');

      expect(serverConfig).toBeDefined();

      // Mutate the returned config
      if (serverConfig) {
        serverConfig.command = ['modified-command'];
        serverConfig.extensions = ['js'];
        if (serverConfig.env) {
          serverConfig.env.KEY = 'modified';
        }
        if (serverConfig.initialization) {
          serverConfig.initialization.setting = 'modified';
        }
      }

      // Get fresh copy - should be affected (same reference)
      const freshConfig = getUserLspConfig('test-server');

      expect(freshConfig?.command).toEqual(['modified-command']);
      expect(freshConfig?.extensions).toEqual(['js']);
      expect(freshConfig?.env).toEqual({ KEY: 'modified' });
      expect(freshConfig?.initialization).toEqual({ setting: 'modified' });
    });
  });

  describe('getAllUserLspConfigs', () => {
    it('returns empty map when no config set', () => {
      const allConfigs = getAllUserLspConfigs();

      expect(allConfigs).toBeInstanceOf(Map);
      expect(allConfigs.size).toBe(0);
    });

    it('returns all configured servers', () => {
      const config = {
        'server-1': {
          command: ['server-1'],
          extensions: ['ts'],
        },
        'server-2': {
          command: ['server-2'],
          extensions: ['js'],
        },
        'server-3': {
          command: ['server-3'],
          extensions: ['py'],
        },
      };

      setUserLspConfig(config);

      const allConfigs = getAllUserLspConfigs();

      expect(allConfigs.size).toBe(3);
      expect(allConfigs.get('server-1')?.id).toBe('server-1');
      expect(allConfigs.get('server-2')?.id).toBe('server-2');
      expect(allConfigs.get('server-3')?.id).toBe('server-3');
    });

    it('returns new Map with same value references - mutation affects store', () => {
      const config = {
        'test-server': {
          command: ['test-server'],
          extensions: ['ts'],
          env: { KEY: 'value' },
          initialization: { setting: 'original' },
        },
      };

      setUserLspConfig(config);

      const allConfigs = getAllUserLspConfigs();

      // Mutate the returned map's value
      const serverConfig = allConfigs.get('test-server');
      if (serverConfig) {
        serverConfig.command = ['modified-command'];
        if (serverConfig.env) {
          serverConfig.env.KEY = 'modified';
        }
      }

      // Get fresh copy - should be affected (same reference)
      const freshConfig = getUserLspConfig('test-server');

      expect(freshConfig?.command).toEqual(['modified-command']);
      expect(freshConfig?.env).toEqual({ KEY: 'modified' });
    });

    it('returns a new Map instance each time', () => {
      setUserLspConfig({
        'test-server': {
          command: ['test-server'],
        },
      });

      const map1 = getAllUserLspConfigs();
      const map2 = getAllUserLspConfigs();

      expect(map1).not.toBe(map2);
      expect(map1.size).toBe(map2.size);
    });
  });

  describe('hasUserLspConfig', () => {
    it('returns false when store is empty', () => {
      expect(hasUserLspConfig()).toBe(false);
    });

    it('returns true when config exists', () => {
      setUserLspConfig({
        'test-server': {
          command: ['test-server'],
        },
      });

      expect(hasUserLspConfig()).toBe(true);
    });

    it('returns false after clearing config', () => {
      setUserLspConfig({
        'test-server': {
          command: ['test-server'],
        },
      });

      expect(hasUserLspConfig()).toBe(true);

      setUserLspConfig(undefined);

      expect(hasUserLspConfig()).toBe(false);
    });

    it('returns true for multiple servers', () => {
      setUserLspConfig({
        'server-1': { command: ['server-1'] },
        'server-2': { command: ['server-2'] },
        'server-3': { command: ['server-3'] },
      });

      expect(hasUserLspConfig()).toBe(true);
    });
  });

  describe('integration tests', () => {
    it('handles complete workflow: set, get, check, clear', () => {
      // Initial state
      expect(hasUserLspConfig()).toBe(false);
      expect(getAllUserLspConfigs().size).toBe(0);

      // Set config
      const config = {
        'typescript-language-server': {
          command: ['typescript-language-server', '--stdio'],
          extensions: ['ts', 'tsx'],
          disabled: false,
          env: { NODE_ENV: 'development' },
          initialization: { maxNumberOfProblems: 100 },
        },
        'eslint-language-server': {
          command: ['vscode-eslint-language-server', '--stdio'],
          extensions: ['js', 'jsx'],
        },
      };

      setUserLspConfig(config);

      // Verify config is set
      expect(hasUserLspConfig()).toBe(true);
      expect(getAllUserLspConfigs().size).toBe(2);

      // Get specific server
      const tsConfig = getUserLspConfig('typescript-language-server');
      expect(tsConfig?.id).toBe('typescript-language-server');
      expect(tsConfig?.command).toEqual([
        'typescript-language-server',
        '--stdio',
      ]);

      // Clear config
      setUserLspConfig(undefined);

      // Verify config is cleared
      expect(hasUserLspConfig()).toBe(false);
      expect(getAllUserLspConfigs().size).toBe(0);
      expect(getUserLspConfig('typescript-language-server')).toBeUndefined();
    });
  });
});
