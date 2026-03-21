// LSP Module - Explicit exports

export { lspManager } from './client';
export { getUserLspConfig, setUserLspConfig } from './config-store';
export {
  lsp_diagnostics,
  lsp_find_references,
  lsp_goto_definition,
  lsp_rename,
} from './tools';

// Re-export types for external use
export type {
  Diagnostic,
  Location,
  LSPServerConfig,
  ResolvedServer,
  WorkspaceEdit,
} from './types';
