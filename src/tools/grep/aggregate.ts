import { CONTEXT_BUFFER_MULTIPLIER } from './constants';
import { decodeRgPayload } from './json-stream';
import {
  buildPathFromBytes,
  getDisplayPath,
  normalizeDisplayText,
  resolveAbsolutePath,
} from './path-utils';
import type {
  GrepContextLine,
  GrepFileMatch,
  GrepMatch,
  GrepSummaryData,
  NormalizedGrepInput,
  RgContextEvent,
  RgEndEvent,
  RgJsonEvent,
  RgMatchEvent,
  RgSummaryEvent,
} from './types';

interface GrepAggregateSnapshot {
  files: GrepFileMatch[];
  totalMatches: number;
  totalFiles: number;
  limitReached: boolean;
  summary?: GrepSummaryData;
}

interface InternalFileState extends GrepFileMatch {
  beforeBuffer: GrepContextLine[];
}

interface ResolvedPathInfo {
  absolutePath: string;
  file: string;
  pathKey: string;
  replayPath?: string;
  nonUtf8Path?: boolean;
}

function trimLineEnd(text: string | undefined): string {
  if (!text) {
    return '';
  }

  const normalized = normalizeDisplayText(text);
  return normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
}

function pushUniqueLineKeepingLast(
  target: GrepContextLine[],
  line: GrepContextLine,
  maxItems: number,
): void {
  const last = target[target.length - 1];
  if (last && last.lineNumber === line.lineNumber && last.text === line.text) {
    return;
  }

  target.push(line);

  if (target.length > maxItems) {
    target.splice(0, target.length - maxItems);
  }
}

function pushUniqueLineKeepingFirst(
  target: GrepContextLine[],
  line: GrepContextLine,
  maxItems: number,
): void {
  const last = target[target.length - 1];
  if (last && last.lineNumber === line.lineNumber && last.text === line.text) {
    return;
  }

  if (target.length >= maxItems) {
    return;
  }

  target.push(line);
}

export class GrepAggregator {
  private readonly files = new Map<string, InternalFileState>();
  private totalMatches = 0;
  private limitReached = false;
  private acceptingMatches = true;
  private stopReady = false;
  private drainPath?: string;
  private drainKey?: string;
  private summary?: GrepSummaryData;

  constructor(
    private readonly input: Pick<
      NormalizedGrepInput,
      'afterContext' | 'beforeContext' | 'cwd' | 'maxResults' | 'worktree'
    >,
  ) {}

  consume(event: RgJsonEvent): void {
    switch (event.type) {
      case 'match':
        this.consumeMatch(event);
        break;
      case 'context':
        this.consumeContext(event);
        break;
      case 'summary':
        this.consumeSummary(event);
        break;
      case 'end':
        this.consumeEnd(event);
        break;
      default:
        break;
    }
  }

  isFull(): boolean {
    return this.stopReady;
  }

  snapshot(): GrepAggregateSnapshot {
    const files = Array.from(this.files.values())
      .filter((file) => file.matches.length > 0)
      .map(({ beforeBuffer: _beforeBuffer, ...file }) => file);

    return {
      files,
      totalMatches: this.totalMatches,
      totalFiles: files.length,
      limitReached: this.limitReached,
      summary: this.summary,
    };
  }

  private consumeMatch(event: RgMatchEvent): void {
    const pathInfo = this.resolvePathInfo(event.data.path);
    const absolutePath = pathInfo.absolutePath;

    if (!this.acceptingMatches) {
      this.limitReached = true;

      if (
        this.drainPath &&
        absolutePath === this.drainPath &&
        pathInfo.pathKey === this.drainKey &&
        this.input.afterContext > 0
      ) {
        this.appendDrainMatchAsAfterContext(pathInfo.pathKey, event);
        return;
      }

      this.stopReady = true;
      return;
    }

    const fileState = this.getFileState(pathInfo);

    if (this.totalMatches >= this.input.maxResults) {
      this.limitReached = true;
      return;
    }

    const before =
      this.input.beforeContext > 0
        ? fileState.beforeBuffer
            .filter((line) => line.lineNumber < event.data.line_number)
            .slice(-this.input.beforeContext)
        : [];

    const match: GrepMatch = {
      lineNumber: event.data.line_number,
      lineText: trimLineEnd(decodeRgPayload(event.data.lines)),
      submatches: event.data.submatches.map((submatch) =>
        decodeRgPayload(submatch.match),
      ),
      before,
      after: [],
    };

    fileState.matches.push(match);
    fileState.matchCount += 1;
    fileState.beforeBuffer = [];
    this.totalMatches += 1;

    if (this.totalMatches >= this.input.maxResults) {
      this.limitReached = true;
      this.acceptingMatches = false;

      if (this.input.afterContext <= 0) {
        this.stopReady = true;
        return;
      }

      this.drainPath = absolutePath;
      this.drainKey = pathInfo.pathKey;
    }
  }

  private appendDrainMatchAsAfterContext(
    pathKey: string,
    event: RgMatchEvent,
  ): void {
    const fileState = this.files.get(pathKey);
    const lastMatch = fileState?.matches[fileState.matches.length - 1];
    if (!fileState || !lastMatch) {
      this.stopReady = true;
      return;
    }

    pushUniqueLineKeepingFirst(
      lastMatch.after,
      {
        lineNumber: event.data.line_number,
        text: trimLineEnd(decodeRgPayload(event.data.lines)),
      },
      this.input.afterContext,
    );

    if (lastMatch.after.length >= this.input.afterContext) {
      this.stopReady = true;
    }
  }

  private consumeContext(event: RgContextEvent): void {
    if (this.input.beforeContext <= 0 && this.input.afterContext <= 0) {
      return;
    }

    const filePath = decodeRgPayload(event.data.path);
    if (
      (!filePath && !event.data.path?.bytes) ||
      typeof event.data.line_number !== 'number'
    ) {
      return;
    }

    const pathInfo = this.resolvePathInfo(event.data.path);
    const absolutePath = pathInfo.absolutePath;
    const fileState = this.getFileState(pathInfo);
    const contextLine = {
      lineNumber: event.data.line_number,
      text: trimLineEnd(decodeRgPayload(event.data.lines)),
    };

    if (this.input.beforeContext > 0) {
      const bufferSize = Math.max(
        this.input.beforeContext,
        this.input.beforeContext * CONTEXT_BUFFER_MULTIPLIER,
      );

      pushUniqueLineKeepingLast(
        fileState.beforeBuffer,
        contextLine,
        bufferSize,
      );
    }

    const lastMatch = fileState.matches[fileState.matches.length - 1];
    if (
      lastMatch &&
      this.input.afterContext > 0 &&
      contextLine.lineNumber > lastMatch.lineNumber
    ) {
      pushUniqueLineKeepingFirst(
        lastMatch.after,
        contextLine,
        this.input.afterContext,
      );

      if (
        !this.acceptingMatches &&
        this.drainPath === absolutePath &&
        this.drainKey === pathInfo.pathKey &&
        lastMatch.after.length >= this.input.afterContext
      ) {
        this.stopReady = true;
      }
    }
  }

  private consumeEnd(event: RgEndEvent): void {
    if (this.acceptingMatches || !this.drainPath) {
      return;
    }

    const absolutePath = event.data.path
      ? this.resolvePathInfo(event.data.path).absolutePath
      : undefined;
    const pathKey = event.data.path
      ? this.resolvePathInfo(event.data.path).pathKey
      : undefined;
    if (
      !absolutePath ||
      (absolutePath === this.drainPath && pathKey === this.drainKey)
    ) {
      this.stopReady = true;
    }
  }

  private consumeSummary(event: RgSummaryEvent): void {
    const elapsed = event.data.elapsed_total;
    this.summary = {
      elapsedTotalMs:
        elapsed == null
          ? undefined
          : Math.round(elapsed.secs * 1000 + elapsed.nanos / 1_000_000),
      elapsedTotalHuman: elapsed?.human,
      stats: event.data.stats,
    };
  }

  private getFileState(pathInfo: ResolvedPathInfo): InternalFileState {
    let fileState = this.files.get(pathInfo.pathKey);
    if (!fileState) {
      fileState = {
        file: pathInfo.file,
        absolutePath: pathInfo.absolutePath,
        replayPath: pathInfo.replayPath,
        nonUtf8Path: pathInfo.nonUtf8Path,
        pathKey: pathInfo.pathKey,
        matchCount: 0,
        matches: [],
        beforeBuffer: [],
      };
      this.files.set(pathInfo.pathKey, fileState);
    }

    return fileState;
  }

  private resolvePathInfo(
    payload:
      | RgMatchEvent['data']['path']
      | RgContextEvent['data']['path']
      | RgEndEvent['data']['path'],
  ): ResolvedPathInfo {
    if (payload?.bytes) {
      const pathInfo = buildPathFromBytes(
        Buffer.from(payload.bytes, 'base64'),
        this.input.cwd,
        this.input.worktree,
      );
      return {
        absolutePath: pathInfo.absolutePath,
        file: pathInfo.displayPath,
        pathKey: pathInfo.pathKey,
        replayPath: pathInfo.replayPath,
        nonUtf8Path: pathInfo.nonUtf8Path,
      };
    }

    const absolutePath = this.resolveAbsolutePath(payload?.text ?? '');
    return {
      absolutePath,
      file: getDisplayPath(absolutePath, this.input.worktree),
      pathKey: `utf8:${absolutePath}`,
      replayPath: absolutePath,
      nonUtf8Path: false,
    };
  }

  private resolveAbsolutePath(filePath: string): string {
    return resolveAbsolutePath(filePath, this.input.cwd);
  }
}
