import type {
  CreateFile,
  DeleteFile,
  Diagnostic,
  DocumentSymbol,
  Location,
  LocationLink,
  Position,
  Range,
  RenameFile,
  SymbolInformation as SymbolInfo,
  TextDocumentEdit,
  TextDocumentIdentifier,
  TextEdit,
  VersionedTextDocumentIdentifier,
  WorkspaceEdit,
} from 'vscode-languageserver-protocol';

export interface LSPServerConfig {
  id: string;
  command: string[];
  extensions: string[];
  rootPatterns?: string[];
  excludePatterns?: string[];
  disabled?: boolean;
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
}

export interface ResolvedServer {
  id: string;
  command: string[];
  extensions: string[];
  rootPatterns?: string[];
  excludePatterns?: string[];
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
}

export type ServerLookupResult =
  | { status: 'found'; server: ResolvedServer }
  | { status: 'not_configured'; extension: string }
  | { status: 'not_installed'; server: ResolvedServer; installHint: string };

export type {
  Position,
  Range,
  Location,
  LocationLink,
  Diagnostic,
  TextDocumentIdentifier,
  VersionedTextDocumentIdentifier,
  TextEdit,
  TextDocumentEdit,
  CreateFile,
  RenameFile,
  DeleteFile,
  WorkspaceEdit,
  SymbolInfo,
  DocumentSymbol,
};
