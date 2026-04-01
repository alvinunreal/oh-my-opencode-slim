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

/**
 * Root function type - mirrors OpenCode core's RootFunction.
 * Returns the project root directory for a given file, or undefined if not applicable.
 */
export type RootFunction = (file: string) => string | undefined;

export interface LSPServerConfig {
  id: string;
  command: string[];
  extensions: string[];
  root?: RootFunction;
  disabled?: boolean;
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
}

export interface ResolvedServer {
  id: string;
  command: string[];
  extensions: string[];
  root?: RootFunction;
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

export interface DocumentDiagnosticReportFull {
  kind: 'full';
  items: Diagnostic[];
  resultId?: string;
}

export interface DocumentDiagnosticReportUnchanged {
  kind: 'unchanged';
  resultId?: string;
}

export type DocumentDiagnosticReport =
  | DocumentDiagnosticReportFull
  | DocumentDiagnosticReportUnchanged;
