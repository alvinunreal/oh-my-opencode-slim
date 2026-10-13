import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveImageRouting } from '../config/constants';
import { processImageAttachments } from './image-hook';
import type { MessageWithParts } from './types';

const TEST_DIR = path.join(os.tmpdir(), `image-hook-test-${process.pid}`);
const IMG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');
const IMG = {
  type: 'image',
  url: `data:image/png;base64,${IMG_BYTES.toString('base64')}`,
};
const IMG_HASH = createHash('sha1').update(IMG_BYTES).digest('hex').slice(0, 8);
const IMG_CONTENT_NAME = `image-${IMG_HASH}.png`;
const HEIC_BYTES = Buffer.concat([
  Buffer.alloc(4),
  Buffer.from('ftypheic', 'latin1'),
  Buffer.alloc(4),
]);
/** Oversized payloads must still sniff as PNG or the byte gate keeps them inline. */
function oversizedBytes(): Buffer {
  return Buffer.concat([
    IMG_BYTES,
    Buffer.alloc(MAX_MEDIA_INGEST_BYTES + 1 - IMG_BYTES.length, 7),
  ]);
}
const IMAGES_GITIGNORE = 'images/\n';
const MAX_MEDIA_INGEST_BYTES = 20 * 1024 * 1024;

function makeTestDir(name: string): { workDir: string; saveDir: string } {
  const workDir = path.join(TEST_DIR, name);
  const saveDir = path.join(workDir, '.opencode', 'images');
  mkdirSync(saveDir, { recursive: true });
  return { workDir, saveDir };
}

function gitignorePath(workDir: string): string {
  return path.join(workDir, '.opencode', '.gitignore');
}

function makeUserMsg(parts: MessageWithParts['parts']): MessageWithParts {
  return { info: { role: 'user', sessionID: 's1' }, parts };
}

function imagePartCount(message: MessageWithParts): number {
  return message.parts.filter((part) => part.type === 'image').length;
}

function nudgeText(message: MessageWithParts): string {
  return message.parts.find((part) => part.type === 'text')?.text ?? '';
}

function savedFiles(saveDir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(saveDir, { withFileTypes: true })) {
    const fullPath = path.join(saveDir, entry.name);
    if (entry.isDirectory()) {
      for (const child of readdirSync(fullPath)) {
        files.push(path.join(fullPath, child));
      }
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

const AUTO = {
  imageRouting: 'auto' as const,
  disabledAgents: new Set<string>(),
  log: () => {},
};

function processAuto(messages: MessageWithParts[], workDir: string): boolean {
  return processImageAttachments({ messages, workDir, ...AUTO });
}

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('processImageAttachments routing', () => {
  it('leaves image parts untouched in direct mode without filesystem work', () => {
    const workDir = path.join(TEST_DIR, 'direct');
    const message = makeUserMsg([IMG]);

    const result = processImageAttachments({
      messages: [message],
      workDir,
      imageRouting: 'direct',
      disabledAgents: new Set(),
      log: () => {},
    });

    expect(result).toBe(false);
    expect(imagePartCount(message)).toBe(1);
    expect(existsSync(path.join(workDir, '.opencode'))).toBe(false);
  });

  it('keeps image parts inline in auto mode when the model accepts image input', () => {
    const workDir = path.join(TEST_DIR, 'auto-native-vision');
    const message = makeUserMsg([IMG]);

    const result = processImageAttachments({
      messages: [message],
      workDir,
      imageRouting: 'auto',
      disabledAgents: new Set(),
      modelAcceptsImages: true,
      log: () => {},
    });

    expect(result).toBe(false);
    expect(imagePartCount(message)).toBe(1);
    expect(existsSync(path.join(workDir, '.opencode'))).toBe(false);
  });

  it('intercepts in auto mode when the model is known to lack image input', () => {
    const workDir = path.join(TEST_DIR, 'auto-no-vision');
    const message = makeUserMsg([IMG]);

    const result = processImageAttachments({
      messages: [message],
      workDir,
      imageRouting: 'auto',
      disabledAgents: new Set(),
      modelAcceptsImages: false,
      log: () => {},
    });

    expect(result).toBe(false);
    expect(imagePartCount(message)).toBe(0);
    expect(
      message.parts.some((part: unknown) =>
        JSON.stringify(part).includes('[Image saved to:'),
      ),
    ).toBe(true);
  });

  it('does no filesystem work on text-only auto transforms', () => {
    const workDir = path.join(TEST_DIR, 'text-only');
    const message = makeUserMsg([{ type: 'text', text: 'hello' }]);

    expect(processAuto([message], workDir)).toBe(false);
    expect(existsSync(path.join(workDir, '.opencode'))).toBe(false);
  });

  it('does no filesystem work when every image part is remote', () => {
    const workDir = path.join(TEST_DIR, 'remote-only');
    const message = makeUserMsg([
      { type: 'image', url: 'https://example.com/a.png' },
      {
        type: 'media',
        media: {
          mediaType: 'image/png',
          source: { type: 'url', url: 'https://example.com/b.png' },
        },
        filename: 'b.png',
      },
    ]);

    expect(processAuto([message], workDir)).toBe(false);
    expect(existsSync(path.join(workDir, '.opencode'))).toBe(false);
    // All original parts stay inline; the host's capability replacement is
    // the backstop for remote images.
    expect(message.parts).toHaveLength(2);
  });

  it('saves an attachment, protects the workspace, and nudges observer', () => {
    const workDir = path.join(TEST_DIR, 'auto');
    const message = makeUserMsg([IMG]);

    expect(processAuto([message], workDir)).toBe(false);
    expect(imagePartCount(message)).toBe(0);
    expect(nudgeText(message)).toContain('Image saved to:');
    expect(nudgeText(message)).toContain('@observer');
    expect(nudgeText(message)).toContain(path.join('.opencode', 'images'));
    expect(readFileSync(gitignorePath(workDir), 'utf8')).toBe(IMAGES_GITIGNORE);
    expect(savedFiles(path.join(workDir, '.opencode', 'images'))).toHaveLength(
      1,
    );
  });

  it('does not migrate the retired legacy wildcard gitignore', () => {
    const workDir = path.join(TEST_DIR, 'legacy-no-migration');
    mkdirSync(path.join(workDir, '.opencode'), { recursive: true });
    writeFileSync(gitignorePath(workDir), '*\n');
    const message = makeUserMsg([{ type: 'text', text: 'hello' }]);

    processImageAttachments({
      messages: [message],
      workDir,
      imageRouting: 'direct',
      disabledAgents: new Set(),
      log: () => {},
    });

    expect(readFileSync(gitignorePath(workDir), 'utf8')).toBe('*\n');
    expect(
      existsSync(
        path.join(
          workDir,
          '.opencode',
          '.gitignore.oh-my-opencode-slim-legacy',
        ),
      ),
    ).toBe(false);
  });

  it('appends images/ once when a new image is written', () => {
    const workDir = path.join(TEST_DIR, 'gitignore-custom');
    mkdirSync(path.join(workDir, '.opencode'), { recursive: true });
    writeFileSync(gitignorePath(workDir), '# local rules\n*.tmp');

    processAuto([makeUserMsg([IMG])], workDir);
    const first = readFileSync(gitignorePath(workDir), 'utf8');
    processAuto([makeUserMsg([IMG])], workDir);
    const second = readFileSync(gitignorePath(workDir), 'utf8');

    expect(first).toBe('# local rules\n*.tmp\nimages/\n');
    expect(second).toBe(first);
  });

  it('preserves a binary gitignore prefix while appending images/', () => {
    const workDir = path.join(TEST_DIR, 'gitignore-binary');
    mkdirSync(path.join(workDir, '.opencode'), { recursive: true });
    const prefix = Buffer.from([0xff, 0xfe, 0x00, 0x23, 0x0a]);
    writeFileSync(gitignorePath(workDir), prefix);

    processAuto([makeUserMsg([IMG])], workDir);

    const result = readFileSync(gitignorePath(workDir));
    expect(result.subarray(0, prefix.length)).toEqual(prefix);
    expect(result.subarray(prefix.length).toString()).toBe(IMAGES_GITIGNORE);
  });

  it('does not mutate an external gitignore symlink', () => {
    const workDir = path.join(TEST_DIR, 'gitignore-symlink');
    const external = path.join(TEST_DIR, 'gitignore-symlink-external');
    mkdirSync(path.join(workDir, '.opencode'), { recursive: true });
    writeFileSync(external, '# external\n');
    symlinkSync(external, gitignorePath(workDir));

    const message = makeUserMsg([IMG]);
    processAuto([message], workDir);

    expect(readFileSync(external, 'utf8')).toBe('# external\n');
    expect(imagePartCount(message)).toBe(1);
    expect(nudgeText(message)).toBe('');
  });

  it('refuses a symlinked .opencode directory without touching its target', () => {
    const workDir = path.join(TEST_DIR, 'opencode-symlink');
    const external = path.join(TEST_DIR, 'opencode-symlink-external');
    mkdirSync(workDir, { recursive: true });
    mkdirSync(external, { recursive: true });
    symlinkSync(external, path.join(workDir, '.opencode'));

    const message = makeUserMsg([IMG]);
    processAuto([message], workDir);

    expect(imagePartCount(message)).toBe(1);
    expect(readdirSync(external)).toEqual([]);
  });

  it('refuses a symlinked session directory without touching its target', () => {
    const { workDir, saveDir } = makeTestDir('session-symlink');
    const external = path.join(TEST_DIR, 'session-symlink-external');
    mkdirSync(external, { recursive: true });
    writeFileSync(path.join(external, 'marker.txt'), 'external');
    symlinkSync(external, path.join(saveDir, 's1'));

    const message = makeUserMsg([IMG]);
    processAuto([message], workDir);

    expect(imagePartCount(message)).toBe(1);
    expect(readFileSync(path.join(external, 'marker.txt'), 'utf8')).toBe(
      'external',
    );
  });

  it('advances around a symlinked content-addressed candidate', () => {
    const { workDir, saveDir } = makeTestDir('candidate-symlink');
    const sessionDir = path.join(saveDir, 's1');
    mkdirSync(sessionDir, { recursive: true });
    const external = path.join(TEST_DIR, 'candidate-external');
    writeFileSync(external, 'do not overwrite');
    symlinkSync(external, path.join(sessionDir, IMG_CONTENT_NAME));

    const message = makeUserMsg([IMG]);
    processAuto([message], workDir);

    expect(readFileSync(external, 'utf8')).toBe('do not overwrite');
    expect(
      lstatSync(path.join(sessionDir, IMG_CONTENT_NAME)).isSymbolicLink(),
    ).toBe(true);
    expect(existsSync(path.join(sessionDir, `image-${IMG_HASH}-1.png`))).toBe(
      true,
    );
    expect(imagePartCount(message)).toBe(0);
  });

  it('advances around a non-file entry occupying the content-addressed name', () => {
    const { workDir, saveDir } = makeTestDir('non-file-collision');
    const sessionDir = path.join(saveDir, 's1');
    mkdirSync(sessionDir, { recursive: true });
    // A directory squatting on the content-addressed name must not be reused.
    mkdirSync(path.join(sessionDir, IMG_CONTENT_NAME), { recursive: true });

    const message = makeUserMsg([IMG]);
    processAuto([message], workDir);

    expect(imagePartCount(message)).toBe(0);
    const suffixed = path.join(sessionDir, `image-${IMG_HASH}-1.png`);
    expect(existsSync(suffixed)).toBe(true);
    expect(
      lstatSync(path.join(sessionDir, IMG_CONTENT_NAME)).isDirectory(),
    ).toBe(true);
    expect(nudgeText(message)).toContain(suffixed);
  });

  it('fails open when an image cannot be materialized', () => {
    const workDir = path.join(TEST_DIR, 'unsaved');
    const message = makeUserMsg([
      { type: 'image', url: 'https://example.com/image.png' },
    ]);

    processAuto([message], workDir);

    expect(imagePartCount(message)).toBe(1);
    expect(message.parts).toHaveLength(1);
  });

  it('removes a truncated file when the image write fails mid-way', async () => {
    const { workDir, saveDir } = makeTestDir('partial-write');
    const fs = await import('node:fs');
    const originalWrite = fs.writeFileSync;
    const spy = spyOn(fs, 'writeFileSync').mockImplementation(((
      p: unknown,
      d: unknown,
      o: unknown,
    ) => {
      const opts = o as { flag?: string } | undefined;
      if (String(p).includes('image-') && opts?.flag === 'wx') {
        // Simulate a partial write that lands on disk, then a hard failure.
        (originalWrite as typeof fs.writeFileSync)(
          p as string,
          Buffer.from('truncated'),
          { flag: 'wx' },
        );
        const err = new Error('no space left on device') as Error & {
          code: string;
        };
        err.code = 'ENOSPC';
        throw err;
      }
      return (originalWrite as typeof fs.writeFileSync)(
        p as never,
        d as never,
        o as never,
      );
    }) as never);

    try {
      const message = makeUserMsg([IMG]);
      processAuto([message], workDir);

      // Fail-open: the original part is retained, nothing is stripped.
      expect(imagePartCount(message)).toBe(1);
      // The truncated file must be gone: no corrupt bytes left for reuse.
      const sessionDir = path.join(saveDir, 's1');
      const leftovers = existsSync(sessionDir) ? readdirSync(sessionDir) : [];
      expect(leftovers).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('strips only image parts that were saved successfully', () => {
    const message = makeUserMsg([
      IMG,
      { type: 'image', url: 'https://example.com/image.png' },
    ]);

    processAuto([message], path.join(TEST_DIR, 'mixed-save'));

    expect(imagePartCount(message)).toBe(1);
    expect(nudgeText(message)).toContain('@observer');
  });

  it('checks only the newest user message when observer is disabled', () => {
    const earlier = makeUserMsg([IMG]);
    const latest = makeUserMsg([{ type: 'text', text: 'follow-up' }]);
    const logMessages: string[] = [];

    const result = processImageAttachments({
      messages: [earlier, latest],
      workDir: path.join(TEST_DIR, 'disabled-earlier'),
      imageRouting: 'auto',
      disabledAgents: new Set(['observer']),
      log: (message) => logMessages.push(message),
    });

    expect(result).toBe(false);
    expect(imagePartCount(earlier)).toBe(1);
    expect(logMessages).toEqual([]);

    const newestImage = makeUserMsg([IMG]);
    const secondResult = processImageAttachments({
      messages: [earlier, newestImage],
      workDir: path.join(TEST_DIR, 'disabled-newest'),
      imageRouting: 'auto',
      disabledAgents: new Set(['observer']),
      log: (message) => logMessages.push(message),
    });

    expect(secondResult).toBe(true);
    expect(imagePartCount(newestImage)).toBe(1);
    expect(logMessages.at(-1)).toContain('retained inline');
  });

  it('reuses the content-addressed file without creating a duplicate', () => {
    const { workDir, saveDir } = makeTestDir('dedup');
    const first = makeUserMsg([IMG]);
    const second = makeUserMsg([IMG]);

    processAuto([first], workDir);
    processAuto([second], workDir);

    const files = savedFiles(saveDir);
    expect(files).toHaveLength(1);
    expect(nudgeText(second)).toContain(path.basename(files[0] as string));
  });

  it('restores the images gitignore rule when only reused images are saved', () => {
    const { workDir } = makeTestDir('gitignore-restore');
    processAuto([makeUserMsg([IMG])], workDir);
    expect(readFileSync(gitignorePath(workDir), 'utf8')).toBe(IMAGES_GITIGNORE);

    // Externally deleted rules must be restored even when the next transform
    // only reuses the existing content-addressed file (Greptile P1).
    rmSync(gitignorePath(workDir));
    const message = makeUserMsg([IMG]);
    processAuto([message], workDir);

    expect(readFileSync(gitignorePath(workDir), 'utf8')).toBe(IMAGES_GITIGNORE);
    expect(imagePartCount(message)).toBe(0);
  });

  it('archives oversized images and excludes them from the delegation nudge', () => {
    const bytes = oversizedBytes();
    const message = makeUserMsg([
      {
        type: 'media',
        mediaType: 'image/png',
        data: bytes.toString('base64'),
        filename: 'large.png',
      },
    ]);

    processAuto([message], path.join(TEST_DIR, 'oversized'));

    const text = nudgeText(message);
    expect(imagePartCount(message)).toBe(0);
    expect(text).toContain('Too large for the read tool');
    expect(text).toContain('compress or crop');
    expect(text).not.toContain('@observer');
    expect(
      savedFiles(path.join(TEST_DIR, 'oversized', '.opencode', 'images')),
    ).toHaveLength(1);
  }, 30_000);

  it('separates readable and oversized paths in one nudge', () => {
    const oversized = oversizedBytes();
    const message = makeUserMsg([
      IMG,
      {
        type: 'media',
        mediaType: 'image/png',
        data: oversized.toString('base64'),
        filename: 'huge.png',
      },
    ]);

    processAuto([message], path.join(TEST_DIR, 'mixed-oversize'));

    const text = nudgeText(message);
    expect(imagePartCount(message)).toBe(0);
    expect(text).toContain('Delegate to @observer');
    expect(text).toContain('Too large for the read tool');
    expect(text).toContain('huge-');
  }, 30_000);

  it('saves session-less images at the top level of the images directory', () => {
    const { workDir, saveDir } = makeTestDir('sessionless');
    const message: MessageWithParts = {
      info: { role: 'user' },
      parts: [IMG],
    };

    processAuto([message], workDir);

    const files = savedFiles(saveDir);
    expect(files).toHaveLength(1);
    expect(path.dirname(files[0] as string)).toBe(saveDir);
    expect(imagePartCount(message)).toBe(0);
  });

  it('saves images from multiple messages in one transform', () => {
    const { workDir, saveDir } = makeTestDir('multi-message');
    const first = makeUserMsg([IMG]);
    const second = makeUserMsg([IMG]);

    processAuto([first, second], workDir);

    expect(imagePartCount(first)).toBe(0);
    expect(imagePartCount(second)).toBe(0);
    expect(nudgeText(first)).toContain('image-');
    expect(nudgeText(second)).toContain('image-');
    // Same content across messages: one content-addressed file, reused.
    expect(savedFiles(saveDir)).toHaveLength(1);
  });

  it('handles v2 media, v1 file, and non-image media parts', () => {
    const bytes = IMG_BYTES;
    const v2 = makeUserMsg([
      {
        type: 'media',
        mediaType: 'image/png',
        data: bytes.toString('base64'),
        filename: 'shot.png',
      },
    ]);
    const v1 = makeUserMsg([
      {
        type: 'file',
        mime: 'image/png',
        url: `data:image/png;base64,${bytes.toString('base64')}`,
        filename: 'photo.png',
      },
    ]);
    const audio = makeUserMsg([
      {
        type: 'media',
        mediaType: 'audio/mpeg',
        data: Buffer.from('clip').toString('base64'),
        filename: 'clip.mp3',
      },
    ]);

    processAuto([v2], path.join(TEST_DIR, 'v2-media'));
    processAuto([v1], path.join(TEST_DIR, 'v1-file'));
    processAuto([audio], path.join(TEST_DIR, 'audio'));

    expect(imagePartCount(v2)).toBe(0);
    expect(v1.parts.some((part) => part.type === 'file')).toBe(false);
    expect(audio.parts).toHaveLength(1);
  });

  it('leaves undecodable media untouched', () => {
    const message = makeUserMsg([
      {
        type: 'media',
        mediaType: 'image/png',
        data: '',
        filename: 'empty.png',
      },
    ]);

    processAuto([message], path.join(TEST_DIR, 'empty-media'));

    expect(message.parts).toHaveLength(1);
    expect(message.parts[0]?.type).toBe('media');
  });
});

describe('v2.0.14+ Media.Asset parts (#1247)', () => {
  const ASSET_BASE64 = IMG_BYTES.toString('base64');

  function assetPart(
    source: Record<string, unknown>,
    mediaOverrides: Record<string, unknown> = {},
    filename = 'clipboard',
  ) {
    return {
      type: 'media',
      media: {
        mediaType: 'image/png',
        kind: 'image',
        source,
        ...mediaOverrides,
      },
      filename,
    };
  }

  it('saves, strips, and nudges for a clipboard Asset with a base64 source', () => {
    const { workDir, saveDir } = makeTestDir('asset-clipboard');
    const message = makeUserMsg([
      assetPart({ type: 'base64', data: ASSET_BASE64, mediaType: 'image/png' }),
    ]);

    processAuto([message], workDir);

    expect(message.parts.some((part) => part.type === 'media')).toBe(false);
    const text = nudgeText(message);
    expect(text).toContain('@observer');
    const files = savedFiles(path.join(saveDir, 's1'));
    expect(files).toHaveLength(1);
    expect(path.basename(files[0] as string)).toBe(`clipboard-${IMG_HASH}.png`);
  });

  it('saves the JSON-replayed Asset form (no top-level mediaType, bytes-as-string)', () => {
    const { workDir, saveDir } = makeTestDir('asset-json-replay');
    // Asset.toJSON emits { source } only; bytes sources serialize their data
    // as base64 strings while keeping type === 'bytes'.
    const message = makeUserMsg([
      {
        type: 'media',
        media: {
          source: { type: 'bytes', data: ASSET_BASE64, mediaType: 'image/png' },
        },
        filename: 'replayed.png',
      },
    ]);

    processAuto([message], workDir);

    expect(message.parts.some((part) => part.type === 'media')).toBe(false);
    expect(
      savedFiles(path.join(saveDir, 's1')).map((file) => path.basename(file)),
    ).toEqual([`replayed-${IMG_HASH}.png`]);
  });

  it('keeps Asset url sources inline while stripping sibling images', () => {
    const { workDir } = makeTestDir('asset-url');
    const message = makeUserMsg([
      assetPart({ type: 'url', url: 'https://example.com/a.png' }),
      {
        type: 'media',
        mediaType: 'image/png',
        data: ASSET_BASE64,
        filename: 'flat.png',
      },
    ]);

    processAuto([message], workDir);

    const mediaParts = message.parts.filter((part) => part.type === 'media');
    expect(mediaParts).toHaveLength(1);
    const kept = mediaParts[0] as {
      media: { source: { type: string } };
    };
    expect(kept.media.source.type).toBe('url');
    expect(nudgeText(message)).toContain('flat-');
  });

  it('retains Asset images inline when observer is disabled', () => {
    const message = makeUserMsg([
      assetPart({ type: 'base64', data: ASSET_BASE64, mediaType: 'image/png' }),
    ]);
    const logMessages: string[] = [];

    const result = processImageAttachments({
      messages: [message],
      workDir: path.join(TEST_DIR, 'asset-disabled'),
      imageRouting: 'auto',
      disabledAgents: new Set(['observer']),
      log: (entry) => logMessages.push(entry),
    });

    expect(result).toBe(true);
    expect(message.parts).toHaveLength(1);
    expect(message.parts[0]?.type).toBe('media');
    expect(logMessages.at(-1)).toContain('retained inline');
  });

  it('archives oversized Asset images without the delegation nudge', () => {
    const huge = new Uint8Array(oversizedBytes());
    const message = makeUserMsg([
      assetPart(
        { type: 'bytes', data: huge, mediaType: 'image/png' },
        {},
        'huge.png',
      ),
    ]);

    processAuto([message], path.join(TEST_DIR, 'asset-oversized'));

    const text = nudgeText(message);
    expect(message.parts.some((part) => part.type === 'media')).toBe(false);
    expect(text).toContain('Too large for the read tool');
    expect(text).not.toContain('@observer');
    expect(
      savedFiles(
        path.join(TEST_DIR, 'asset-oversized', '.opencode', 'images', 's1'),
      ),
    ).toHaveLength(1);
  }, 30_000);

  it('saves flat media with Uint8Array data (dev shape)', () => {
    const { workDir, saveDir } = makeTestDir('flat-uint8');
    const message = makeUserMsg([
      {
        type: 'media',
        mediaType: 'image/png',
        data: new Uint8Array(IMG_BYTES),
        filename: 'shot.png',
      },
    ]);

    processAuto([message], workDir);

    expect(message.parts.some((part) => part.type === 'media')).toBe(false);
    expect(
      savedFiles(path.join(saveDir, 's1')).map((file) => path.basename(file)),
    ).toEqual([`shot-${IMG_HASH}.png`]);
  });

  it('keeps a lying heic image inline end-to-end (no strip, no save, no nudge)', () => {
    // The hole this revision closes: declared image/heic + photo.png
    // filename + real HEIC bytes used to be saved as a .png the observer
    // could never read (the host read tool re-sniffs actual bytes and
    // rejects anything outside its four-mime set).
    const workDir = path.join(TEST_DIR, 'heic-hole');
    const message = makeUserMsg([
      {
        type: 'media',
        mediaType: 'image/heic',
        data: HEIC_BYTES.toString('base64'),
        filename: 'photo.png',
      },
    ]);

    expect(processAuto([message], workDir)).toBe(false);
    expect(message.parts).toHaveLength(1);
    expect(message.parts[0]?.type).toBe('media');
    expect(nudgeText(message)).toBe('');
    expect(existsSync(path.join(workDir, '.opencode'))).toBe(false);
  });

  it('still warns when observer is disabled and only unconsumable images remain', () => {
    const message = makeUserMsg([
      {
        type: 'media',
        mediaType: 'image/heic',
        data: HEIC_BYTES.toString('base64'),
        filename: 'photo.png',
      },
    ]);
    const logMessages: string[] = [];

    const result = processImageAttachments({
      messages: [message],
      workDir: path.join(TEST_DIR, 'heic-disabled'),
      imageRouting: 'auto',
      disabledAgents: new Set(['observer']),
      log: (entry) => logMessages.push(entry),
    });

    expect(result).toBe(true);
    expect(message.parts).toHaveLength(1);
    expect(logMessages.at(-1)).toContain('retained inline');
  });

  it('does not treat untyped non-image payloads as images', () => {
    // Greptile P2: an untyped ZIP must not trigger the image warning —
    // enabling the observer could not make it viewable anyway.
    const workDir = path.join(TEST_DIR, 'untyped-zip');
    const message = makeUserMsg([
      {
        type: 'media',
        mediaType: 'application/octet-stream',
        data: Buffer.from('PK\x03\x04-archive').toString('base64'),
        filename: 'archive',
      },
    ]);
    const logMessages: string[] = [];

    const result = processImageAttachments({
      messages: [message],
      workDir,
      imageRouting: 'auto',
      disabledAgents: new Set(['observer']),
      log: (entry) => logMessages.push(entry),
    });

    expect(result).toBe(false);
    expect(message.parts).toHaveLength(1);
    expect(logMessages).toEqual([]);
    expect(existsSync(path.join(workDir, '.opencode'))).toBe(false);
  });
});

describe('resolveImageRouting', () => {
  it('uses auto when omitted and observer is enabled', () => {
    expect(resolveImageRouting(undefined, true)).toBe('auto');
  });

  it('uses direct when omitted and observer is disabled', () => {
    expect(resolveImageRouting(undefined, false)).toBe('direct');
  });

  it('preserves explicit routing choices', () => {
    expect(resolveImageRouting('auto', false)).toBe('auto');
    expect(resolveImageRouting('direct', true)).toBe('direct');
  });
});
