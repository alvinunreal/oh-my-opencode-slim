import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Mock fs BEFORE importing modules
mock.module('fs', () => ({
  readFileSync: mock(() => ''),
  writeFileSync: mock(),
  unlinkSync: mock(),
  existsSync: mock(() => false),
  statSync: mock(() => ({ isDirectory: () => false })),
}));

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  applyWorkspaceEdit,
  filterDiagnosticsBySeverity,
  findServerProjectRoot,
  formatApplyResult,
  formatDiagnostic,
  formatLocation,
  formatSeverity,
  uriToPath,
} from './utils';

describe('utils', () => {
  beforeEach(() => {
    (readFileSync as any).mockClear();
    (writeFileSync as any).mockClear();
    (unlinkSync as any).mockClear();
    (existsSync as any).mockClear();
    (existsSync as any).mockImplementation(() => false);
  });

  describe('findServerProjectRoot', () => {
    test('should return file directory when no root patterns', () => {
      const server = { id: 'test', command: ['test'], extensions: ['.ts'] };
      const result = findServerProjectRoot('/project/src/file.ts', server);
      expect(result).toContain('src');
    });

    test('should find root when root pattern exists', () => {
      // Mock existsSync to return true only for deno.json
      (existsSync as any).mockImplementation((path: string) => {
        return path === '/project/deno.json';
      });
      const server = {
        id: 'deno',
        command: ['deno', 'lsp'],
        extensions: ['.ts'],
        rootPatterns: ['deno.json'],
      };
      const result = findServerProjectRoot('/project/src/file.ts', server);
      expect(result).toBe('/project');
    });

    test('should return undefined when excluded by excludePattern', () => {
      // Mock existsSync to return true for deno.json (exclusion pattern)
      (existsSync as any).mockImplementation((path: string) => {
        return path === '/project/deno.json';
      });
      const server = {
        id: 'typescript',
        command: ['tsserver'],
        extensions: ['.ts'],
        rootPatterns: ['package.json'],
        excludePatterns: ['deno.json'],
      };
      const result = findServerProjectRoot('/project/src/file.ts', server);
      expect(result).toBeUndefined();
    });

    test('should find root when exclude pattern is not present', () => {
      // Mock existsSync to return true for package.json but not deno.json
      (existsSync as any).mockImplementation((path: string) => {
        return path === '/project/package.json';
      });
      const server = {
        id: 'typescript',
        command: ['tsserver'],
        extensions: ['.ts'],
        rootPatterns: ['package.json'],
        excludePatterns: ['deno.json'],
      };
      const result = findServerProjectRoot('/project/src/file.ts', server);
      expect(result).toBe('/project');
    });

    test('should fall back to file directory when no patterns match', () => {
      (existsSync as any).mockImplementation(() => false);
      const server = {
        id: 'test',
        command: ['test'],
        extensions: ['.ts'],
        rootPatterns: ['Makefile'],
      };
      const result = findServerProjectRoot('/project/src/file.ts', server);
      expect(result).toBe('/project/src');
    });
  });

  describe('uriToPath', () => {
    test('should convert file URI to path', () => {
      const uri = 'file:///home/user/project/file.ts';
      const path = uriToPath(uri);
      expect(path).toContain('home');
      expect(path).toContain('file.ts');
    });
  });

  describe('formatLocation', () => {
    test('should format Location object', () => {
      const loc = {
        uri: 'file:///home/user/test.ts',
        range: {
          start: { line: 9, character: 5 },
          end: { line: 9, character: 10 },
        },
      };
      const formatted = formatLocation(loc);
      expect(formatted).toContain('test.ts:10:5');
    });
  });

  describe('formatSeverity', () => {
    test('should map severity numbers to strings', () => {
      expect(formatSeverity(1)).toBe('error');
      expect(formatSeverity(2)).toBe('warning');
      expect(formatSeverity(3)).toBe('information');
      expect(formatSeverity(4)).toBe('hint');
      expect(formatSeverity(undefined)).toBe('unknown');
    });
  });

  describe('formatDiagnostic', () => {
    test('should format diagnostic correctly', () => {
      const diag = {
        severity: 1,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
        message: 'Unexpected token',
        source: 'eslint',
        code: 'no-unused-vars',
      };
      const formatted = formatDiagnostic(diag as any);
      expect(formatted).toBe(
        'error[eslint] (no-unused-vars) at 1:0: Unexpected token',
      );
    });
  });

  describe('filterDiagnosticsBySeverity', () => {
    const diags = [
      { severity: 1, message: 'e1' },
      { severity: 2, message: 'w1' },
    ] as any[];

    test('should filter by error', () => {
      const filtered = filterDiagnosticsBySeverity(diags, 'error');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].severity).toBe(1);
    });
  });

  describe('applyWorkspaceEdit', () => {
    test('should apply single file edit', () => {
      const uri = 'file:///test.ts';
      const filePath = uriToPath(uri);
      (readFileSync as any).mockReturnValue('line1\nline2\nline3');

      const edit = {
        changes: {
          [uri]: [
            {
              range: {
                start: { line: 1, character: 0 },
                end: { line: 1, character: 5 },
              },
              newText: 'replaced',
            },
          ],
        },
      };

      const result = applyWorkspaceEdit(edit as any);
      expect(result.success).toBe(true);
      expect(result.filesModified).toContain(filePath);
      expect(writeFileSync).toHaveBeenCalled();
    });

    test('should handle overlapping edits by sorting them in reverse order', () => {
      const uri = 'file:///test.ts';
      (readFileSync as any).mockReturnValue('abcde');

      const edit = {
        changes: {
          [uri]: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
              newText: '1',
            },
            {
              range: {
                start: { line: 0, character: 2 },
                end: { line: 0, character: 3 },
              },
              newText: '3',
            },
          ],
        },
      };

      const result = applyWorkspaceEdit(edit as any);
      expect(result.success).toBe(true);
      const writtenContent = (writeFileSync as any).mock.calls[0][1];
      expect(writtenContent).toBe('1b3de');
    });

    test('should handle create file operation', () => {
      const edit = {
        documentChanges: [{ kind: 'create', uri: 'file:///new.ts' }],
      };

      const result = applyWorkspaceEdit(edit as any);
      expect(result.success).toBe(true);
      expect(writeFileSync).toHaveBeenCalledWith(
        uriToPath('file:///new.ts'),
        '',
        'utf-8',
      );
    });

    test('should handle rename file operation', () => {
      const oldUri = 'file:///old.ts';
      const newUri = 'file:///new.ts';
      (readFileSync as any).mockReturnValue('some content');

      const edit = {
        documentChanges: [{ kind: 'rename', oldUri, newUri }],
      };

      const result = applyWorkspaceEdit(edit as any);
      expect(result.success).toBe(true);
      expect(writeFileSync).toHaveBeenCalledWith(
        uriToPath(newUri),
        'some content',
        'utf-8',
      );
      expect(unlinkSync).toHaveBeenCalledWith(uriToPath(oldUri));
    });

    test('should handle delete file operation', () => {
      const uri = 'file:///delete.ts';
      const edit = {
        documentChanges: [{ kind: 'delete', uri }],
      };

      const result = applyWorkspaceEdit(edit as any);
      expect(result.success).toBe(true);
      expect(unlinkSync).toHaveBeenCalledWith(uriToPath(uri));
    });

    test('should return error if no edit provided', () => {
      const result = applyWorkspaceEdit(null);
      expect(result.success).toBe(false);
      expect(result.errors).toContain('No edit provided');
    });
  });

  describe('formatApplyResult', () => {
    test('should format successful result', () => {
      const result = {
        success: true,
        filesModified: ['/home/user/file1.ts'],
        totalEdits: 1,
        errors: [],
      };
      const formatted = formatApplyResult(result);
      expect(formatted).toContain('Applied 1 edit(s)');
    });
  });
});
