// LSP constants - mirrors OpenCode core servers (no auto-download)
// All server definitions from OpenCode's LSPServer namespace

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { LSPServerConfig, RootFunction } from './types';

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

// Common root patterns shared by multiple servers
const LOCK_FILE_PATTERNS = [
  'package-lock.json',
  'bun.lockb',
  'bun.lock',
  'pnpm-lock.yaml',
  'yarn.lock',
];

/**
 * Generator that walks up the directory tree yielding each directory.
 * Mirrors OpenCode core's Filesystem.up() utility.
 */
function* walkUpDirectories(
  start: string,
  stop: string,
): Generator<string, void, unknown> {
  let dir = resolve(start);

  // If start is a file (not a directory), start from its parent
  try {
    if (!statSync(dir).isDirectory()) {
      dir = dirname(dir);
    }
  } catch {
    dir = dirname(dir);
  }

  let prevDir = '';
  while (dir !== prevDir && dir !== '/') {
    yield dir;
    prevDir = dir;
    if (dir === stop) break;
    dir = dirname(dir);
  }
}

/**
 * NearestRoot helper - mirrors OpenCode core's NearestRoot function.
 * Creates a RootFunction that walks up directories looking for root markers.
 */
export function NearestRoot(
  includePatterns: string[],
  excludePatterns?: string[],
): RootFunction {
  return (file: string): string | undefined => {
    const cwd = process.cwd();

    // Check for exclusion patterns first
    if (excludePatterns) {
      for (const dir of walkUpDirectories(file, cwd)) {
        for (const pattern of excludePatterns) {
          if (existsSync(`${dir}/${pattern}`)) {
            // Found an exclusion marker - this server should not activate
            return undefined;
          }
        }
      }
    }

    // Find nearest root pattern
    for (const dir of walkUpDirectories(file, cwd)) {
      for (const pattern of includePatterns) {
        if (pattern.includes('*')) {
          // Handle glob patterns (e.g., *.xcodeproj, *.tf)
          try {
            const entries = readdirSync(dir);
            const regex = new RegExp(
              `^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`,
            );
            if (entries.some((entry) => regex.test(entry))) {
              return dir;
            }
          } catch {
            // Skip directories that can't be read
          }
        } else if (existsSync(`${dir}/${pattern}`)) {
          return dir;
        }
      }
    }

    // No root found - return undefined (let caller decide fallback)
    return undefined;
  };
}

/**
 * Built-in LSP servers - mirrors OpenCode core LSPServer namespace.
 * User configuration from opencode.json lsp section takes precedence and is
 * merged on top of these: user settings override command/extensions/env, while
 * root patterns are always preserved from built-in. Servers can be removed by
 * setting `"disabled": true` in the user config.
 */
export const BUILTIN_SERVERS: Record<string, Omit<LSPServerConfig, 'id'>> = {
  // ============ JavaScript/TypeScript Ecosystem ============

  deno: {
    command: ['deno', 'lsp'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs'],
    root: NearestRoot(['deno.json', 'deno.jsonc']),
  },

  typescript: {
    command: ['typescript-language-server', '--stdio'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
    root: NearestRoot(LOCK_FILE_PATTERNS, ['deno.json', 'deno.jsonc']),
  },

  vue: {
    command: ['vue-language-server', '--stdio'],
    extensions: ['.vue'],
    root: NearestRoot(LOCK_FILE_PATTERNS),
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
      '.mts',
      '.cts',
      '.vue',
    ],
    root: NearestRoot(LOCK_FILE_PATTERNS),
  },

  oxlint: {
    command: ['oxlint', '--lsp'],
    extensions: [
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.mts',
      '.cts',
      '.vue',
      '.astro',
      '.svelte',
    ],
    root: NearestRoot([
      '.oxlintrc.json',
      ...LOCK_FILE_PATTERNS,
      'package.json',
    ]),
  },

  biome: {
    command: ['biome', 'lsp-proxy', '--stdio'],
    extensions: [
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.mts',
      '.cts',
      '.json',
      '.jsonc',
      '.vue',
      '.astro',
      '.svelte',
      '.css',
      '.graphql',
      '.gql',
      '.html',
    ],
    root: NearestRoot(['biome.json', 'biome.jsonc', ...LOCK_FILE_PATTERNS]),
  },

  // ============ Backend Languages ============

  gopls: {
    command: ['gopls'],
    extensions: ['.go'],
    root: NearestRoot(['go.work', 'go.mod', 'go.sum']),
  },

  ruby_lsp: {
    // Note: uses rubocop --lsp (RuboCop's built-in LSP linting mode),
    // not the separate ruby-lsp gem. Users wanting full ruby-lsp features
    // should configure: { command: ["ruby-lsp"] }
    command: ['rubocop', '--lsp'],
    extensions: ['.rb', '.rake', '.gemspec', '.ru'],
    root: NearestRoot(['Gemfile']),
  },

  ty: {
    command: ['ty', 'server'],
    extensions: ['.py', '.pyi'],
    root: NearestRoot([
      'pyproject.toml',
      'ty.toml',
      'setup.py',
      'setup.cfg',
      'requirements.txt',
      'Pipfile',
      'pyrightconfig.json',
    ]),
  },

  pyright: {
    command: ['pyright-langserver', '--stdio'],
    extensions: ['.py', '.pyi'],
    root: NearestRoot([
      'pyproject.toml',
      'setup.py',
      'setup.cfg',
      'requirements.txt',
      'Pipfile',
      'pyrightconfig.json',
    ]),
  },

  elixir_ls: {
    command: ['elixir-ls'],
    extensions: ['.ex', '.exs'],
    root: NearestRoot(['mix.exs', 'mix.lock']),
  },

  zls: {
    command: ['zls'],
    extensions: ['.zig', '.zon'],
    root: NearestRoot(['build.zig']),
  },

  // ============ .NET Languages ============

  csharp: {
    command: ['csharp-ls'],
    extensions: ['.cs'],
    root: NearestRoot(['.slnx', '.sln', '.csproj', 'global.json']),
  },

  fsharp: {
    command: ['fsautocomplete'],
    extensions: ['.fs', '.fsi', '.fsx', '.fsscript'],
    root: NearestRoot(['.slnx', '.sln', '.fsproj', 'global.json']),
  },

  // ============ Apple Languages ============

  sourcekit_lsp: {
    command: ['sourcekit-lsp'],
    extensions: ['.swift', '.objc', '.objcpp'],
    root: NearestRoot(['Package.swift', '*.xcodeproj', '*.xcworkspace']),
  },

  // ============ Rust ============

  rust: {
    command: ['rust-analyzer'],
    extensions: ['.rs'],
    root: NearestRoot(['Cargo.toml', 'Cargo.lock']),
  },

  // ============ C/C++ ============

  clangd: {
    command: ['clangd', '--background-index', '--clang-tidy'],
    extensions: [
      '.c',
      '.cpp',
      '.cc',
      '.cxx',
      '.c++',
      '.h',
      '.hpp',
      '.hh',
      '.hxx',
      '.h++',
    ],
    root: NearestRoot([
      'compile_commands.json',
      'compile_flags.txt',
      '.clangd',
      'CMakeLists.txt',
      'Makefile',
    ]),
  },

  // ============ Frontend Frameworks ============

  svelte: {
    command: ['svelteserver', '--stdio'],
    extensions: ['.svelte'],
    root: NearestRoot(LOCK_FILE_PATTERNS),
  },

  astro: {
    command: ['astro-ls', '--stdio'],
    extensions: ['.astro'],
    root: NearestRoot(LOCK_FILE_PATTERNS),
  },

  // ============ Java/JVM Languages ============

  jdtls: {
    // Complex java -jar invocation - requires special setup
    // Users should configure their own command for JDTLS
    command: ['jdtls'],
    extensions: ['.java'],
    root: NearestRoot([
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
      '.project',
      '.classpath',
    ]),
  },

  kotlin_ls: {
    command: ['kotlin-lsp', '--stdio'],
    extensions: ['.kt', '.kts'],
    root: NearestRoot([
      'settings.gradle.kts',
      'settings.gradle',
      'gradlew',
      'build.gradle.kts',
      'build.gradle',
      'pom.xml',
    ]),
  },

  // ============ Config/ Markup Languages ============

  yaml_ls: {
    command: ['yaml-language-server', '--stdio'],
    extensions: ['.yaml', '.yml'],
    root: NearestRoot(LOCK_FILE_PATTERNS),
  },

  lua_ls: {
    command: ['lua-language-server'],
    extensions: ['.lua'],
    root: NearestRoot([
      '.luarc.json',
      '.luarc.jsonc',
      '.luacheckrc',
      'stylua.toml',
      'selene.toml',
      'selene.yml',
    ]),
  },

  php_intelephense: {
    command: ['intelephense', '--stdio'],
    extensions: ['.php'],
    root: NearestRoot(['composer.json', 'composer.lock', '.php-version']),
  },

  prisma: {
    command: ['prisma', 'language-server'],
    extensions: ['.prisma'],
    root: NearestRoot(['schema.prisma', 'prisma/schema.prisma', 'prisma']),
  },

  dart: {
    command: ['dart', 'language-server', '--lsp'],
    extensions: ['.dart'],
    root: NearestRoot(['pubspec.yaml', 'analysis_options.yaml']),
  },

  ocaml_lsp: {
    command: ['ocamllsp'],
    extensions: ['.ml', '.mli'],
    root: NearestRoot(['dune-project', 'dune-workspace', '.merlin', 'opam']),
  },

  // ============ Shell/Scripts ============

  bash: {
    command: ['bash-language-server', 'start'],
    extensions: ['.sh', '.bash', '.zsh', '.ksh'],
    root: undefined, // No root detection needed - uses file directory
  },

  // ============ Infrastructure/ DevOps ============

  terraform_ls: {
    command: ['terraform-ls', 'serve'],
    extensions: ['.tf', '.tfvars'],
    root: NearestRoot(['.terraform.lock.hcl', 'terraform.tfstate', '*.tf']),
  },

  // ============ Document/ Publishing ============

  texlab: {
    command: ['texlab'],
    extensions: ['.tex', '.bib'],
    root: NearestRoot(['.latexmkrc', 'latexmkrc', '.texlabroot', 'texlabroot']),
  },

  dockerfile: {
    command: ['docker-langserver', '--stdio'],
    extensions: ['.dockerfile', 'Dockerfile'],
    root: undefined, // No root detection needed - uses file directory
  },

  // ============ Functional Languages ============

  gleam: {
    command: ['gleam', 'lsp'],
    extensions: ['.gleam'],
    root: NearestRoot(['gleam.toml']),
  },

  clojure_lsp: {
    command: ['clojure-lsp', 'listen'],
    extensions: ['.clj', '.cljs', '.cljc', '.edn'],
    root: NearestRoot([
      'deps.edn',
      'project.clj',
      'shadow-cljs.edn',
      'bb.edn',
      'build.boot',
    ]),
  },

  nixd: {
    command: ['nixd'],
    extensions: ['.nix'],
    root: NearestRoot(['flake.nix']),
  },

  tinymist: {
    command: ['tinymist'],
    extensions: ['.typ', '.typc'],
    root: NearestRoot(['typst.toml']),
  },

  haskell_language_server: {
    command: ['haskell-language-server-wrapper', '--lsp'],
    extensions: ['.hs', '.lhs'],
    root: NearestRoot(['stack.yaml', 'cabal.project', 'hie.yaml', '*.cabal']),
  },

  julials: {
    command: [
      'julia',
      '--startup-file=no',
      '--history-file=no',
      '-e',
      'using LanguageServer; runserver()',
    ],
    extensions: ['.jl'],
    root: NearestRoot(['Project.toml', 'Manifest.toml', '*.jl']),
  },
};

export const LSP_INSTALL_HINTS: Record<string, string> = {
  // JavaScript/TypeScript Ecosystem
  deno: 'Install Deno: https://deno.land/#installation',
  typescript: 'npm install -g typescript-language-server typescript',
  vue: 'npm install -g @vue/language-server',
  eslint: 'npm install -g vscode-langservers-extracted',
  oxlint: 'npm install -g oxlint or install via package manager',
  biome: 'npm install -g @biomejs/biome',

  // Backend Languages
  gopls: 'go install golang.org/x/tools/gopls@latest',
  ruby_lsp: 'gem install rubocop (Ruby LSP runs via rubocop --lsp)',
  ty: 'pip install ty or see https://github.com/astral-sh/ty',
  pyright: 'pip install pyright',
  elixir_ls:
    'Download from https://github.com/elixir-lsp/elixir-ls/releases or build from source',
  zls: 'Install via your package manager or build from source: https://github.com/zigtools/zls',

  // .NET Languages
  csharp: 'dotnet tool install --global csharp-ls',
  fsharp: 'dotnet tool install --global fsautocomplete',

  // Apple Languages
  sourcekit_lsp: 'Install via Xcode or Swift toolchain (included with Xcode)',

  // Rust
  rust: 'rustup component add rust-analyzer',

  // C/C++
  clangd: 'Install clangd via your system package manager or LLVM',

  // Frontend Frameworks
  svelte: 'npm install -g svelte-language-server',
  astro: 'npm install -g @astrojs/language-server',

  // Java/JVM Languages
  jdtls: 'See https://github.com/eclipse-jdtls/eclipse.jdt.ls for installation',
  kotlin_ls: 'Download from https://github.com/Kotlin/kotlin-lsp/releases',

  // Config/ Markup Languages
  yaml_ls: 'npm install -g yaml-language-server',
  lua_ls: 'Download from https://github.com/LuaLS/lua-language-server/releases',
  php_intelephense: 'npm install -g intelephense',
  prisma: 'npm install -g @prisma/language-server or use npx',
  dart: 'dart pub global activate language_server',
  ocaml_lsp: 'opam install ocaml-lsp-server',

  // Shell/Scripts
  bash: 'npm install -g bash-language-server',

  // Infrastructure/ DevOps
  terraform_ls:
    'Download from https://github.com/hashicorp/terraform-ls/releases or install via tfenv',

  // Document/ Publishing
  texlab: 'Download from https://github.com/latex-lsp/texlab/releases',
  dockerfile: 'npm install -g dockerfile-language-server-nodejs',

  // Functional Languages
  gleam: 'Install Gleam: https://gleam.run/getting-started/',
  clojure_lsp:
    'Install via deps.edn, project.clj, or: clj -M -m clojure-lsp.main',
  nixd: 'Install via nix-env or your system package manager',
  tinymist: 'cargo install tinymist or download from releases',
  haskell_language_server:
    'Install Haskell Tool Stack or Cabal, then language-server',
  julials: 'Install Julia: https://julialang.org/downloads/',
};

/**
 * Maps file extensions to LSP language IDs.
 * Mirrors OpenCode core's LANGUAGE_EXTENSIONS constant.
 */
export const LANGUAGE_EXTENSIONS: Record<string, string> = {
  // JavaScript/TypeScript
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ets': 'typescript',

  // Vue
  '.vue': 'vue',

  // Svelte
  '.svelte': 'svelte',

  // Astro
  '.astro': 'astro',

  // HTML/XML
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.xsl': 'xsl',

  // CSS/SCSS/Less
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',

  // JSON
  '.json': 'json',
  '.jsonc': 'json',

  // GraphQL
  '.graphql': 'graphql',
  '.gql': 'graphql',

  // Web/Build
  '.dockerfile': 'dockerfile',
  '.sh': 'shellscript',
  '.bash': 'shellscript',
  '.zsh': 'shellscript',
  '.ksh': 'shellscript',

  // Go
  '.go': 'go',

  // Rust
  '.rs': 'rust',

  // Python
  '.py': 'python',
  '.pyi': 'python',

  // Ruby
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.gemspec': 'ruby',
  '.ru': 'ruby',

  // C/C++
  '.c': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c++': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.h++': 'cpp',

  // Java
  '.java': 'java',

  // Kotlin
  '.kt': 'kotlin',
  '.kts': 'kotlin',

  // C#
  '.cs': 'csharp',

  // F#
  '.fs': 'fsharp',
  '.fsi': 'fsharp',
  '.fsx': 'fsharp',
  '.fsscript': 'fsharp',

  // Swift/Objective-C
  '.swift': 'swift',
  '.m': 'objective-c',
  '.mm': 'objective-cpp',

  // Zig
  '.zig': 'zig',
  '.zon': 'zig',

  // Elixir
  '.ex': 'elixir',
  '.exs': 'elixir',

  // Clojure
  '.clj': 'clojure',
  '.cljs': 'clojure',
  '.cljc': 'clojure',
  '.edn': 'clojure',

  // Haskell
  '.hs': 'haskell',
  '.lhs': 'haskell',

  // OCaml
  '.ml': 'ocaml',
  '.mli': 'ocaml',

  // Scala
  '.scala': 'scala',

  // PHP
  '.php': 'php',

  // Lua
  '.lua': 'lua',

  // Dart
  '.dart': 'dart',

  // YAML
  '.yaml': 'yaml',
  '.yml': 'yaml',

  // Terraform
  '.tf': 'terraform',
  '.tfvars': 'terraform-vars',
  '.hcl': 'hcl',

  // Nix
  '.nix': 'nix',

  // Typst
  '.typ': 'typst',
  '.typc': 'typst',

  // LaTeX
  '.tex': 'latex',
  '.latex': 'latex',
  '.bib': 'bibtex',
  '.bibtex': 'bibtex',

  // Prisma
  '.prisma': 'prisma',

  // Julia
  '.jl': 'julia',

  // Gleam
  '.gleam': 'gleam',

  // Markdown
  '.md': 'markdown',
  '.markdown': 'markdown',

  // Other
  '.d': 'd',
  '.pas': 'pascal',
  '.pascal': 'pascal',
  '.diff': 'diff',
  '.patch': 'diff',
  '.erl': 'erlang',
  '.hrl': 'erlang',
  '.groovy': 'groovy',
  '.handlebars': 'handlebars',
  '.hbs': 'handlebars',
  '.ini': 'ini',
  '.makefile': 'makefile',
  makefile: 'makefile',
  '.pug': 'jade',
  '.jade': 'jade',
  '.r': 'r',
  '.cshtml': 'razor',
  '.razor': 'razor',
  '.erb': 'erb',
  '.html.erb': 'erb',
  '.js.erb': 'erb',
  '.css.erb': 'erb',
  '.json.erb': 'erb',
  '.shader': 'shaderlab',
  '.sql': 'sql',
  '.perl': 'perl',
  '.pl': 'perl',
  '.pm': 'perl',
  '.pm6': 'perl6',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.coffee': 'coffeescript',
  '.bat': 'bat',
  '.abap': 'abap',
  '.gitcommit': 'git-commit',
  '.gitrebase': 'git-rebase',
};
