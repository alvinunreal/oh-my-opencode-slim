import { readFile } from 'node:fs/promises';
import { POINTER_CONSTRAINTS } from './config';
import { recordPointerResolution } from './metrics';
import { loadThreadArchive } from './thread-manager';
import type { ParsedPointer } from './types';

export class PointerResolver {
  private resolutionCount = 0;
  private readonly maxResolutions: number;

  constructor(
    maxResolutions: number = POINTER_CONSTRAINTS.maxResolutionsPerTask,
  ) {
    this.maxResolutions = maxResolutions;
  }

  canResolve(): boolean {
    return this.resolutionCount < this.maxResolutions;
  }

  remaining(): number {
    return this.maxResolutions - this.resolutionCount;
  }

  async resolve(pointer: string): Promise<string | null> {
    if (!this.canResolve()) {
      return `[Resolution quota exceeded: ${this.resolutionCount}/${this.maxResolutions}]`;
    }

    const parsed = this.parsePointer(pointer);
    if (!parsed) {
      return `[Invalid pointer format: ${pointer}]`;
    }

    let result: string | null = null;

    switch (parsed.type) {
      case 'thread':
        result = await this.resolveThreadPointer(parsed);
        break;
      case 'cmd':
        // cmd: pointers reference transient tool outputs that are not persisted.
        result = `[Command output ${parsed.id} not available]`;
        break;
      case 'file':
        result = await this.resolveFilePointer(parsed);
        break;
    }

    if (result) {
      this.resolutionCount++;
      recordPointerResolution();
      const truncated = this.truncate(
        result,
        POINTER_CONSTRAINTS.resolutionMaxChars,
      );
      return truncated;
    }

    return null;
  }

  private parsePointer(pointer: string): ParsedPointer | null {
    const threadMatch = pointer.match(/^thread:([^#]+)(?:#(.+))?$/);
    if (threadMatch) {
      return { type: 'thread', id: threadMatch[1], detail: threadMatch[2] };
    }

    const cmdMatch = pointer.match(/^cmd:([^#]+)(?:#line:(\d+)(?:-(\d+))?)?$/);
    if (cmdMatch) {
      return {
        type: 'cmd',
        id: cmdMatch[1],
        detail: cmdMatch[2]
          ? cmdMatch[3]
            ? `${cmdMatch[2]}-${cmdMatch[3]}`
            : cmdMatch[2]
          : undefined,
      };
    }

    const fileMatch = pointer.match(/^file:([^:]+):(\d+)(?:-(\d+))?$/);
    if (fileMatch) {
      return {
        type: 'file',
        id: fileMatch[1],
        detail: fileMatch[3] ? `${fileMatch[2]}-${fileMatch[3]}` : fileMatch[2],
      };
    }

    return null;
  }

  private async resolveThreadPointer(
    parsed: ParsedPointer,
  ): Promise<string | null> {
    const archive = await loadThreadArchive(parsed.id);
    if (!archive) {
      return `[Thread ${parsed.id} not found]`;
    }

    if (parsed.detail === 'context') {
      const lastMessages = archive.conversation.slice(-3);
      return JSON.stringify(lastMessages, null, 2);
    }

    return JSON.stringify(archive.packet, null, 2);
  }

  private async resolveFilePointer(
    parsed: ParsedPointer,
  ): Promise<string | null> {
    try {
      const content = await readFile(parsed.id, 'utf-8');

      if (parsed.detail) {
        const lines = content.split('\n');
        const [start, end] = parsed.detail.split('-').map(Number);
        return lines.slice(start - 1, end ?? start).join('\n');
      }

      return content;
    } catch {
      return `[File ${parsed.id} not found]`;
    }
  }

  private truncate(content: string, maxChars: number): string {
    if (content.length <= maxChars) {
      return content;
    }
    return `${content.slice(0, maxChars)}\n... [truncated]`;
  }

  reset(): void {
    this.resolutionCount = 0;
  }
}
