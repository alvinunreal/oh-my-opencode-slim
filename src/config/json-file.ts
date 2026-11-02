import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  applyEdits,
  createScanner,
  modify,
  parseTree,
  SyntaxKind,
} from 'jsonc-parser';
import { MarketplaceLockOwnershipError } from '../marketplace/errors';
import { acquireMarketplaceLease, writeAtomic } from '../marketplace/lease';
import { getMarketplacePaths } from '../marketplace/paths';
import { type JsonConfig, parseJsonConfigText } from './jsonc';
import { resolveConfigWritePath } from './write-path';

const pendingConfigLeaseCleanup = new Map<
  string,
  ReturnType<typeof acquireMarketplaceLease>
>();

function configWriteLockPaths(configPath: string) {
  const absolutePath = resolveConfigWritePath(configPath);
  const lockRoot = join(
    dirname(absolutePath),
    `.${basename(absolutePath)}.write-lock`,
  );
  return getMarketplacePaths(lockRoot);
}

function retryPendingConfigLeaseCleanup(lockDir: string): void {
  const cleanupKey = resolve(lockDir);
  const pending = pendingConfigLeaseCleanup.get(cleanupKey);
  if (!pending) return;

  try {
    pending.release();
  } catch (error) {
    if (!(error instanceof MarketplaceLockOwnershipError)) throw error;
  }
  if (pendingConfigLeaseCleanup.get(cleanupKey) === pending) {
    pendingConfigLeaseCleanup.delete(cleanupKey);
  }
}

function withConfigWriteLease<T>(configPath: string, operation: () => T): T {
  const paths = configWriteLockPaths(configPath);
  retryPendingConfigLeaseCleanup(paths.lockDir);
  const lease = acquireMarketplaceLease(paths);
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    result = lease.commit(operation);
  } catch (error) {
    operationError = error;
    operationFailed = true;
  }

  try {
    lease.release();
    for (const directory of [paths.lockDir, paths.rootDir]) {
      try {
        rmdirSync(directory);
      } catch {
        // A concurrent writer or a cleanup failure leaves the directory intact.
      }
    }
  } catch (releaseError) {
    pendingConfigLeaseCleanup.set(resolve(paths.lockDir), lease);
    if (!operationFailed) throw releaseError;
  }
  if (operationFailed) throw operationError;
  return result as T;
}

/** Run a config operation under the same cross-process lease as its writer. */
export function withSerializedConfigWrites<T>(
  configPaths: string[],
  operation: () => T,
): T {
  const orderedPaths = [
    ...new Set(configPaths.map(resolveConfigWritePath)),
  ].sort();
  const acquire = (index: number): T => {
    if (index === orderedPaths.length) return operation();
    return withConfigWriteLease(orderedPaths[index], () => acquire(index + 1));
  };
  return acquire(0);
}

function hasSameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => hasSameJsonValue(value, right[index]))
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false;
  }

  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftObject).filter(
    (key) => leftObject[key] !== undefined,
  );
  const rightKeys = Object.keys(rightObject).filter(
    (key) => rightObject[key] !== undefined,
  );
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightObject, key) &&
        hasSameJsonValue(leftObject[key], rightObject[key]),
    )
  );
}

function writeBackupAtomic(configPath: string, content: string): void {
  const backupPath = `${configPath}.bak`;
  const parent = dirname(backupPath);
  mkdirSync(parent, { recursive: true });
  const temporaryPath = `${backupPath}.${process.pid}.${randomUUID()}.tmp`;
  const mode = statSync(configPath).mode & 0o7777;
  try {
    const fd = openSync(temporaryPath, 'wx', 0o600);
    try {
      fchmodSync(fd, mode);
      writeFileSync(fd, content, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporaryPath, backupPath);
  } finally {
    try {
      if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
    } catch {
      // Failed backup-temp cleanup must not mask the original write error.
    }
  }
}

function publishConfig(
  configPath: string,
  config: JsonConfig,
  currentText?: string,
): void {
  const targetPath = resolveConfigWritePath(configPath);
  if (currentText !== undefined) writeBackupAtomic(configPath, currentText);

  const bom = currentText?.startsWith('\uFEFF') ? '\uFEFF' : '';
  const content = currentText
    ? `${bom}${jsoncDiff(
        currentText.replace(/^\uFEFF/, ''),
        parseJsonConfigText(currentText),
        config,
      )}`
    : `${bom}${JSON.stringify(config, null, 2)}\n`;
  writeAtomic(targetPath, content);
}

export interface PreparedJsonConfigWrite {
  configPath: string;
  originalText?: string;
  content: string;
  changed: boolean;
}

/** Render a JSON/JSONC edit without publishing it. */
export function prepareJsonConfigWrite(
  configPath: string,
  currentText: string | undefined,
  config: JsonConfig,
): PreparedJsonConfigWrite {
  const current = currentText ? parseJsonConfigText(currentText) : {};
  if (currentText !== undefined && hasSameJsonValue(current, config)) {
    return {
      configPath,
      originalText: currentText,
      content: currentText,
      changed: false,
    };
  }
  const bom = currentText?.startsWith('\uFEFF') ? '\uFEFF' : '';
  const content = currentText
    ? `${bom}${jsoncDiff(currentText.replace(/^\uFEFF/, ''), current, config)}`
    : `${bom}${JSON.stringify(config, null, 2)}\n`;

  return {
    configPath,
    originalText: currentText,
    content:
      currentText !== undefined && content === currentText
        ? currentText
        : content,
    changed: content !== currentText,
  };
}

/** Publish prepared bytes under an already-held config write lease. */
export function publishPreparedJsonConfig(
  prepared: PreparedJsonConfigWrite,
): void {
  if (!prepared.changed) return;

  const targetPath = resolveConfigWritePath(prepared.configPath);

  if (prepared.originalText !== undefined) {
    writeBackupAtomic(prepared.configPath, prepared.originalText);
  }
  writeAtomic(targetPath, prepared.content);
}

/** Restore the exact pre-transaction bytes without replacing its backup. */
export function restorePreparedJsonConfig(
  prepared: PreparedJsonConfigWrite,
): void {
  const targetPath = resolveConfigWritePath(prepared.configPath);
  if (prepared.originalText === undefined) {
    rmSync(targetPath, { force: true });
    return;
  }
  writeAtomic(targetPath, prepared.originalText);
}

function jsoncFormattingOptions(source: string) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const indentation = source.match(/(?:^|\r?\n)([ \t]+)"/);
  const indent = indentation?.[1] ?? '  ';
  return {
    insertSpaces: !indent.includes('\t'),
    tabSize: indent.length,
    eol,
  };
}

function jsoncDiff(
  source: string,
  original: unknown,
  updated: unknown,
  path: (string | number)[] = [],
): string {
  if (JSON.stringify(original) === JSON.stringify(updated)) return source;

  if (
    Array.isArray(original) &&
    Array.isArray(updated) &&
    original.length === updated.length
  ) {
    return updated.reduce(
      (latest, value, index) =>
        jsoncDiff(latest, original[index], value, [...path, index]),
      source,
    );
  }

  if (
    original &&
    updated &&
    typeof original === 'object' &&
    typeof updated === 'object' &&
    !Array.isArray(original) &&
    !Array.isArray(updated)
  ) {
    const before = original as Record<string, unknown>;
    const after = updated as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    let latest = source;
    for (const key of keys) {
      const beforeHas = Object.hasOwn(before, key);
      const afterHas = Object.hasOwn(after, key);
      if (beforeHas && afterHas) {
        latest = jsoncDiff(latest, before[key], after[key], [...path, key]);
      } else {
        const edits = modify(
          latest,
          [...path, key],
          afterHas ? after[key] : undefined,
          { formattingOptions: jsoncFormattingOptions(latest) },
        );
        latest = applyEdits(latest, edits);
      }
    }
    return latest;
  }

  const edits = modify(source, path, updated, {
    formattingOptions: jsoncFormattingOptions(source),
  });
  return applyEdits(source, edits);
}

/** Atomically publish a JSON value with a backup of the previous file. */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  withConfigWriteLease(filePath, () => {
    const previous = existsSync(filePath)
      ? readFileSync(filePath, 'utf-8')
      : undefined;
    publishConfig(filePath, value as JsonConfig, previous);
  });
}

/** Read, mutate, and atomically publish a JSON/JSONC config under one lease. */
function findCommaToken(
  source: string,
  start: number,
  end: number,
  preferLast = false,
): { offset: number; length: number } | undefined {
  const scanner = createScanner(source, false);
  scanner.setPosition(start);
  let match: { offset: number; length: number } | undefined;
  while (scanner.getPosition() <= end) {
    const token = scanner.scan();
    if (token === SyntaxKind.EOF) break;
    const offset = scanner.getTokenOffset();
    if (offset >= end) break;
    if (token === SyntaxKind.CommaToken) {
      match = { offset, length: scanner.getTokenLength() };
      if (!preferLast) return match;
    }
  }
  return match;
}

/**
 * Remove all matching top-level JSON/JSONC properties while preserving comments belonging
 * to neighboring properties. Token scanning distinguishes real separators from
 * commas inside comments/strings.
 */
export function removeTopLevelJsonProperty(
  configPath: string,
  propertyName: string,
): void {
  withConfigWriteLease(configPath, () => {
    if (!existsSync(configPath)) return;

    const currentText = readFileSync(configPath, 'utf-8');
    const hasBom = currentText.startsWith('\uFEFF');
    let updated = hasBom ? currentText.slice(1) : currentText;
    let removedAny = false;

    // JSON permits duplicate object keys even though the parsed value only
    // exposes the last one. Re-parse after each token-preserving removal so a
    // successful call guarantees that no matching top-level override remains.
    while (true) {
      const errors: Parameters<typeof parseTree>[1] = [];
      const root = parseTree(updated, errors, { allowTrailingComma: true });
      if (errors.length > 0 || root?.type !== 'object') {
        throw new Error('Invalid JSONC config');
      }

      const properties = (root.children ?? []).filter(
        (node) => node.type === 'property',
      );
      const index = properties.findIndex(
        (property) => property.children?.[0]?.value === propertyName,
      );
      if (index < 0) break;

      const property = properties[index];
      const propertyEnd = property.offset + property.length;
      const removals: Array<{ start: number; end: number }> = [
        { start: property.offset, end: propertyEnd },
      ];

      if (index < properties.length - 1) {
        const next = properties[index + 1];
        const comma = findCommaToken(updated, propertyEnd, next.offset);
        if (!comma) {
          throw new Error('Could not locate JSONC property separator');
        }
        removals.push({
          start: comma.offset,
          end: comma.offset + comma.length,
        });
      } else {
        if (properties.length > 1) {
          const previous = properties[index - 1];
          const comma = findCommaToken(
            updated,
            previous.offset + previous.length,
            property.offset,
            true,
          );
          if (!comma) {
            throw new Error('Could not locate JSONC property separator');
          }
          removals.push({
            start: comma.offset,
            end: comma.offset + comma.length,
          });
        }

        // JSONC permits a trailing comma after the last property. Remove that
        // token too, but preserve all whitespace/comments around it.
        const rootEnd = root.offset + root.length;
        const trailingComma = findCommaToken(updated, propertyEnd, rootEnd);
        if (trailingComma) {
          removals.push({
            start: trailingComma.offset,
            end: trailingComma.offset + trailingComma.length,
          });
        }
      }

      for (const removal of removals.sort((a, b) => b.start - a.start)) {
        updated = updated.slice(0, removal.start) + updated.slice(removal.end);
      }
      removedAny = true;
    }

    if (!removedAny) return;
    parseJsonConfigText(updated);
    writeBackupAtomic(configPath, currentText);
    writeAtomic(
      resolveConfigWritePath(configPath),
      `${hasBom ? '\uFEFF' : ''}${updated}`,
    );
  });
}

export function mutateJsonFile(
  configPath: string,
  mutate: (current: JsonConfig) => JsonConfig,
): void {
  withConfigWriteLease(configPath, () => {
    const currentText = existsSync(configPath)
      ? readFileSync(configPath, 'utf-8')
      : undefined;
    const current = currentText ? parseJsonConfigText(currentText) : {};
    const originalSnapshot = JSON.parse(JSON.stringify(current)) as JsonConfig;
    const updated = mutate(current);
    if (JSON.stringify(updated) === JSON.stringify(originalSnapshot)) return;
    publishConfig(configPath, updated, currentText);
  });
}
