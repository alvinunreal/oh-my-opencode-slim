// Slim LSP constants - only essential languages

import type { LSPServerConfig } from './types';

export const SYMBOL_KIND_MAP: Record<number, string> = {
  1: 'File',
  2: 'Module',
  3: 'Namespace',
  4: 'Package',
  5: 'Class',
  6: 'Method',
  7: 'Property',
  8: 'Field',
  9: 'Constructor',
  10: 'Enum',
  11: 'Interface',
  12: 'Function',
  13: 'Variable',
  14: 'Constant',
  15: 'String',
  16: 'Number',
  17: 'Boolean',
  18: 'Array',
  19: 'Object',
  20: 'Key',
  21: 'Null',
  22: 'EnumMember',
  23: 'Struct',
  24: 'Event',
  25: 'Operator',
  26: 'TypeParameter',
};

export const SEVERITY_MAP: Record<number, string> = {
  1: 'error',
  2: 'warning',
  3: 'information',
  4: 'hint',
};

export const DEFAULT_MAX_REFERENCES = 200;
export const DEFAULT_MAX_DIAGNOSTICS = 200;

/**
 * @deprecated BUILTIN_SERVERS is now a FALLBACK only.
 * User configuration from opencode.json lsp section takes precedence.
 * These servers are used only when the user has not configured any LSP servers.
 */
export const BUILTIN_SERVERS: Record<string, Omit<LSPServerConfig, 'id'>> = {
  // JavaScript/TypeScript ecosystem
  typescript: {
    command: ['typescript-language-server', '--stdio'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
  },
  vue: {
    command: ['vue-language-server', '--stdio'],
    extensions: ['.vue'],
  },
  svelte: {
    command: ['svelteserver', '--stdio'],
    extensions: ['.svelte'],
  },
  astro: {
    command: ['astro-ls', '--stdio'],
    extensions: ['.astro'],
  },
  eslint: {
    command: ['vscode-eslint-language-server', '--stdio'],
    extensions: [
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.vue',
      '.svelte',
    ],
  },
  tailwindcss: {
    command: ['tailwindcss-language-server', '--stdio'],
    extensions: ['.html', '.jsx', '.tsx', '.vue', '.svelte', '.astro'],
  },
  // Backend languages
  gopls: {
    command: ['gopls'],
    extensions: ['.go'],
  },
  rust: {
    command: ['rust-analyzer'],
    extensions: ['.rs'],
  },
  basedpyright: {
    command: ['basedpyright-langserver', '--stdio'],
    extensions: ['.py', '.pyi'],
  },
  pyright: {
    command: ['pyright-langserver', '--stdio'],
    extensions: ['.py', '.pyi'],
  },
  clangd: {
    command: ['clangd', '--background-index'],
    extensions: ['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp'],
  },
  zls: {
    command: ['zls'],
    extensions: ['.zig'],
  },
};

export const LSP_INSTALL_HINTS: Record<string, string> = {
  typescript: 'npm install -g typescript-language-server typescript',
  vue: 'npm install -g @vue/language-server',
  svelte: 'npm install -g svelte-language-server',
  astro: 'npm install -g @astrojs/language-server',
  eslint: 'npm install -g vscode-langservers-extracted',
  tailwindcss: 'npm install -g @tailwindcss/language-server',
  gopls: 'go install golang.org/x/tools/gopls@latest',
  rust: 'rustup component add rust-analyzer',
  basedpyright: 'pip install basedpyright',
  pyright: 'pip install pyright',
  clangd: 'See https://clangd.llvm.org/installation',
  zls: 'See https://github.com/zigtools/zls',
};

// Extension to language ID mapping
export const EXT_TO_LANG: Record<string, string> = {
  // TypeScript/JavaScript
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  // Frontend frameworks
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.astro': 'astro',
  // Web
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.json': 'json',
  // Backend
  '.go': 'go',
  '.rs': 'rust',
  '.py': 'python',
  '.pyi': 'python',
  '.c': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.zig': 'zig',
};
