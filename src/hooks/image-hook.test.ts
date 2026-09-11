import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveImageRouting } from '../config/constants';
import { processImageAttachments } from './image-hook';
import type { MessageWithParts } from './types';

const TEST_DIR = path.join(os.tmpdir(), `image-hook-test-${process.pid}`);
const IMG = { type: 'image', url: 'data:image/png;base64,AAAA' };
const IMG_BYTES = Buffer.from('AAAA', 'base64');
const IMG_HASH = createHash('sha1').update(IMG_BYTES).digest('hex').slice(0, 8);
const IMG_CONTENT_NAME = `image-${IMG_HASH}.png`;
const LEGACY_GITIGNORE = '*\n';
const LEGACY_GITIGNORE_BYTES = Buffer.from(LEGACY_GITIGNORE);
const LEGACY_GITIGNORE_BACKUP = '.gitignore.oh-my-opencode-slim-legacy';
const IMAGES_GITIGNORE = 'images/\n';
const IMAGES_GITIGNORE_BYTES = Buffer.from(IMAGES_GITIGNORE);

function makeTestDir(name: string): { workDir: string; saveDir: string } {
  const workDir = path.join(TEST_DIR, name);
  const saveDir = path.join(workDir, '.opencode', 'images');
  mkdirSync(saveDir, { recursive: true });
  return { workDir, saveDir };
}

function gitignorePath(workDir: string): string {
  return path.join(workDir, '.opencode', '.gitignore');
}

function legacyGitignoreBackupPath(workDir: string): string {
  return path.join(workDir, '.opencode', LEGACY_GITIGNORE_BACKUP);
}

function writeOpencodeGitignore(
  workDir: string,
  content: string | Buffer,
): string {
  const opencodeDir = path.join(workDir, '.opencode');
  mkdirSync(opencodeDir, { recursive: true });
  const gi = gitignorePath(workDir);
  writeFileSync(gi, content);
  return gi;
}

function makeOldFile(dir: string, name: string): string {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, 'data');
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(filePath, past, past);
  return filePath;
}

function makeUserMsg(parts: MessageWithParts['parts']): MessageWithParts {
  return { info: { role: 'user', sessionID: 's1' }, parts };
}

function imagePartCount(message: MessageWithParts): number {
  return message.parts.filter((part) => part.type === 'image').length;
}

const AUTO = {
  imageRouting: 'auto' as const,
  disabledAgents: new Set<string>(),
  log: () => {},
};

function processAuto(messages: MessageWithParts[], workDir: string): boolean {
  return processImageAttachments({ messages, workDir, ...AUTO });
}

function nudgeText(message: MessageWithParts): string {
  return message.parts.find((part) => part.type === 'text')?.text ?? '';
}

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('image-hook catch logging', () => {
  it('survives file cleanup failure without throwing', () => {
    const { workDir, saveDir } = makeTestDir('cleanup-fail-1');
    makeOldFile(saveDir, 'old-image.png');
    chmodSync(saveDir, 0o555);

    try {
      expect(() => {
        processImageAttachments({
          messages: [],
          workDir,
          imageRouting: 'auto',
          disabledAgents: new Set<string>(),
          log: () => {},
        });
      }).not.toThrow();
    } finally {
      chmodSync(saveDir, 0o755);
    }
  });

  it('survives subdirectory file cleanup failure without throwing', () => {
    const { workDir, saveDir } = makeTestDir('cleanup-fail-2');
    const sessionDir = path.join(saveDir, 'ses-abc');
    mkdirSync(sessionDir, { recursive: true });
    makeOldFile(sessionDir, 'img.png');
    chmodSync(sessionDir, 0o555);

    try {
      expect(() => {
        processImageAttachments({
          messages: [],
          workDir,
          imageRouting: 'auto',
          disabledAgents: new Set<string>(),
          log: () => {},
        });
      }).not.toThrow();
    } finally {
      chmodSync(sessionDir, 0o755);
    }
  });
});

describe('processImageAttachments image routing', () => {
  it('direct mode leaves image parts untouched', () => {
    const message = makeUserMsg([IMG]);
    const result = processImageAttachments({
      messages: [message],
      workDir: path.join(TEST_DIR, 'direct'),
      imageRouting: 'direct',
      disabledAgents: new Set<string>(),
      log: () => {},
    });
    expect(result).toBe(false);
    expect(imagePartCount(message)).toBe(1);
  });

  it('auto mode saves image parts and adds an @observer nudge', () => {
    const message = makeUserMsg([IMG]);
    const result = processImageAttachments({
      messages: [message],
      workDir: path.join(TEST_DIR, 'auto'),
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: () => {},
    });
    expect(result).toBe(false);
    expect(imagePartCount(message)).toBe(0);
    const textParts = message.parts.filter((part) => part.type === 'text');
    expect(textParts).toHaveLength(1);
    expect(textParts[0]?.text).toContain('@observer');
  });

  it('writes a .gitignore covering only the images directory in a fresh workspace', () => {
    const workDir = path.join(TEST_DIR, 'gitignore-fresh');
    mkdirSync(workDir, { recursive: true });
    expect(existsSync(gitignorePath(workDir))).toBe(false);
    processImageAttachments({
      messages: [makeUserMsg([IMG])],
      workDir,
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: () => {},
    });
    expect(readFileSync(gitignorePath(workDir))).toEqual(
      IMAGES_GITIGNORE_BYTES,
    );
  });

  it('migrates exact legacy * gitignore before early returns (direct/text-only)', () => {
    const workDir = path.join(TEST_DIR, 'gitignore-legacy-direct');
    writeOpencodeGitignore(workDir, LEGACY_GITIGNORE_BYTES);
    const logs: string[] = [];

    processImageAttachments({
      messages: [makeUserMsg([{ type: 'text', text: 'no images' }])],
      workDir,
      imageRouting: 'direct',
      disabledAgents: new Set<string>(),
      log: (message) => logs.push(message),
    });

    expect(readFileSync(gitignorePath(workDir))).toEqual(
      IMAGES_GITIGNORE_BYTES,
    );
    expect(readFileSync(legacyGitignoreBackupPath(workDir))).toEqual(
      LEGACY_GITIGNORE_BYTES,
    );
    expect(logs.some((message) => message.includes('backup created at'))).toBe(
      true,
    );
  });

  it('legacy gitignore migration is idempotent', () => {
    const workDir = path.join(TEST_DIR, 'gitignore-legacy-idempotent');
    writeOpencodeGitignore(workDir, LEGACY_GITIGNORE_BYTES);

    const run = () =>
      processImageAttachments({
        messages: [makeUserMsg([{ type: 'text', text: 'hello' }])],
        workDir,
        imageRouting: 'direct',
        disabledAgents: new Set<string>(),
        log: () => {},
      });

    run();
    expect(readFileSync(gitignorePath(workDir))).toEqual(
      IMAGES_GITIGNORE_BYTES,
    );
    const backupAfterFirst = readFileSync(legacyGitignoreBackupPath(workDir));
    run();
    expect(readFileSync(gitignorePath(workDir))).toEqual(
      IMAGES_GITIGNORE_BYTES,
    );
    expect(readFileSync(legacyGitignoreBackupPath(workDir))).toEqual(
      backupAfterFirst,
    );
  });

  it('uses an exact existing legacy gitignore backup unchanged', () => {
    const workDir = path.join(TEST_DIR, 'gitignore-existing-backup');
    const existingBackup = LEGACY_GITIGNORE_BYTES;
    writeOpencodeGitignore(workDir, LEGACY_GITIGNORE_BYTES);
    writeFileSync(legacyGitignoreBackupPath(workDir), existingBackup);

    processImageAttachments({
      messages: [makeUserMsg([{ type: 'text', text: 'hello' }])],
      workDir,
      imageRouting: 'direct',
      disabledAgents: new Set<string>(),
      log: () => {},
    });

    expect(readFileSync(gitignorePath(workDir))).toEqual(
      IMAGES_GITIGNORE_BYTES,
    );
    expect(readFileSync(legacyGitignoreBackupPath(workDir))).toEqual(
      existingBackup,
    );
  });

  it('keeps an invalid existing backup and legacy gitignore unchanged', () => {
    const workDir = path.join(TEST_DIR, 'gitignore-invalid-backup');
    const invalidBackup = Buffer.from('# unrelated backup\n');
    writeOpencodeGitignore(workDir, LEGACY_GITIGNORE_BYTES);
    writeFileSync(legacyGitignoreBackupPath(workDir), invalidBackup);
    const logs: string[] = [];

    processImageAttachments({
      messages: [makeUserMsg([{ type: 'text', text: 'hello' }])],
      workDir,
      imageRouting: 'direct',
      disabledAgents: new Set<string>(),
      log: (message) => logs.push(message),
    });

    expect(readFileSync(gitignorePath(workDir))).toEqual(
      LEGACY_GITIGNORE_BYTES,
    );
    expect(readFileSync(legacyGitignoreBackupPath(workDir))).toEqual(
      invalidBackup,
    );
    expect(
      logs.some((message) => message.includes('backup is not an exact')),
    ).toBe(true);
  });

  it('keeps a hard-linked backup and legacy gitignore unchanged', () => {
    const workDir = path.join(TEST_DIR, 'gitignore-hardlink-backup');
    const gitignore = writeOpencodeGitignore(workDir, LEGACY_GITIGNORE_BYTES);
    const backup = legacyGitignoreBackupPath(workDir);
    linkSync(gitignore, backup);

    processImageAttachments({
      messages: [makeUserMsg([{ type: 'text', text: 'hello' }])],
      workDir,
      imageRouting: 'direct',
      disabledAgents: new Set<string>(),
      log: () => {},
    });

    expect(readFileSync(gitignore)).toEqual(LEGACY_GITIGNORE_BYTES);
    expect(readFileSync(backup)).toEqual(LEGACY_GITIGNORE_BYTES);
  });

  it('preserves custom gitignore with wildcard/comment byte-for-byte on migration', () => {
    const workDir = path.join(TEST_DIR, 'gitignore-custom-preserve');
    // Contains `*` but is not the exact legacy plugin content.
    const custom = Buffer.from(
      '# keep local secrets\n*.local\n!important.local\n',
    );
    writeOpencodeGitignore(workDir, custom);

    processImageAttachments({
      messages: [makeUserMsg([{ type: 'text', text: 'no images' }])],
      workDir,
      imageRouting: 'direct',
      disabledAgents: new Set<string>(),
      log: () => {},
    });

    expect(readFileSync(gitignorePath(workDir))).toEqual(custom);
    expect(existsSync(legacyGitignoreBackupPath(workDir))).toBe(false);
  });

  it('appends images/ exactly once to custom gitignore when saving images', () => {
    const workDir = path.join(TEST_DIR, 'gitignore-custom-append');
    const custom = Buffer.from('# project rules\n*.tmp');
    writeOpencodeGitignore(workDir, custom);

    const run = () =>
      processImageAttachments({
        messages: [makeUserMsg([IMG])],
        workDir,
        imageRouting: 'auto',
        disabledAgents: new Set<string>(),
        log: () => {},
      });

    run();
    const afterFirst = readFileSync(gitignorePath(workDir));
    expect(afterFirst).toEqual(
      Buffer.concat([custom, Buffer.from('\n'), IMAGES_GITIGNORE_BYTES]),
    );

    run();
    const afterSecond = readFileSync(gitignorePath(workDir));
    expect(afterSecond).toEqual(afterFirst);
    expect(
      afterSecond
        .toString('utf8')
        .split(/\r?\n/)
        .filter((l) => l === 'images/'),
    ).toEqual(['images/']);
  });

  it('preserves non-UTF-8 prefix bytes when appending images/', () => {
    const workDir = path.join(TEST_DIR, 'gitignore-binary-prefix');
    // Invalid UTF-8 lead bytes + a comment line; must survive append intact.
    const prefix = Buffer.from([
      0xff, 0xfe, 0x00, 0x23, 0x20, 0x62, 0x69, 0x6e, 0x0a,
    ]);
    writeOpencodeGitignore(workDir, prefix);

    processImageAttachments({
      messages: [makeUserMsg([IMG])],
      workDir,
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: () => {},
    });

    const after = readFileSync(gitignorePath(workDir));
    expect(after.subarray(0, prefix.length)).toEqual(prefix);
    expect(after.subarray(prefix.length)).toEqual(IMAGES_GITIGNORE_BYTES);
  });

  it('does not mutate external target through symlinked .gitignore', () => {
    const workDir = path.join(TEST_DIR, 'gitignore-symlink-file');
    const external = path.join(TEST_DIR, 'gitignore-symlink-file-external');
    writeFileSync(external, LEGACY_GITIGNORE_BYTES);
    mkdirSync(path.join(workDir, '.opencode'), { recursive: true });
    symlinkSync(external, gitignorePath(workDir));

    const logs: string[] = [];
    processImageAttachments({
      messages: [makeUserMsg([IMG])],
      workDir,
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: (msg) => logs.push(msg),
    });

    expect(readFileSync(external)).toEqual(LEGACY_GITIGNORE_BYTES);
    expect(logs.some((m) => m.includes('symlinked'))).toBe(true);
  });

  it('symlinked .opencode refuses gitignore mutation, external images dir, and keeps attachments', () => {
    const workDir = path.join(TEST_DIR, 'symlink-opencode-dir');
    const externalDir = path.join(TEST_DIR, 'symlink-opencode-dir-external');
    mkdirSync(workDir, { recursive: true });
    mkdirSync(externalDir, { recursive: true });
    const externalGi = path.join(externalDir, '.gitignore');
    const externalContent = Buffer.from('# external custom\n*.bak\n');
    writeFileSync(externalGi, externalContent);
    symlinkSync(externalDir, path.join(workDir, '.opencode'));

    const message = makeUserMsg([IMG]);
    const logs: string[] = [];
    const result = processImageAttachments({
      messages: [message],
      workDir,
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: (msg) => logs.push(msg),
    });

    expect(result).toBe(false);
    expect(imagePartCount(message)).toBe(1);
    expect(readFileSync(externalGi)).toEqual(externalContent);
    expect(existsSync(path.join(externalDir, 'images'))).toBe(false);
    expect(logs.some((m) => m.includes('symlinked'))).toBe(true);
  });

  it('symlinked images dir does not delete external expired files or write images', () => {
    const workDir = path.join(TEST_DIR, 'symlink-images-dir');
    const externalImages = path.join(
      TEST_DIR,
      'symlink-images-dir-external-images',
    );
    mkdirSync(path.join(workDir, '.opencode'), { recursive: true });
    mkdirSync(externalImages, { recursive: true });

    const expired = path.join(externalImages, 'old-external.png');
    writeFileSync(expired, 'external-old');
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(expired, past, past);

    symlinkSync(externalImages, path.join(workDir, '.opencode', 'images'));

    const message = makeUserMsg([IMG]);
    const logs: string[] = [];
    const result = processImageAttachments({
      messages: [message],
      workDir,
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: (msg) => logs.push(msg),
    });

    expect(result).toBe(false);
    expect(imagePartCount(message)).toBe(1);
    expect(existsSync(expired)).toBe(true);
    expect(readFileSync(expired, 'utf8')).toBe('external-old');
    // No session subdirectory or new image written into the external target.
    expect(readdirSync(externalImages)).toEqual(['old-external.png']);
    expect(logs.some((m) => m.includes('symlinked'))).toBe(true);

    // Text-only path must also skip cleanup through the symlink.
    processImageAttachments({
      messages: [makeUserMsg([{ type: 'text', text: 'later' }])],
      workDir,
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: () => {},
    });
    expect(existsSync(expired)).toBe(true);
    expect(readdirSync(externalImages)).toEqual(['old-external.png']);
  });

  it('symlinked session directory keeps attachments and does not touch external target', () => {
    const workDir = path.join(TEST_DIR, 'symlink-session-dir');
    const imagesDir = path.join(workDir, '.opencode', 'images');
    const externalSession = path.join(
      TEST_DIR,
      'symlink-session-dir-external-session',
    );
    mkdirSync(imagesDir, { recursive: true });
    mkdirSync(externalSession, { recursive: true });

    const externalMarker = path.join(externalSession, 'marker.txt');
    writeFileSync(externalMarker, 'session-external');
    // Session id from makeUserMsg is 's1'
    symlinkSync(externalSession, path.join(imagesDir, 's1'));

    const message = makeUserMsg([IMG]);
    const logs: string[] = [];
    const result = processImageAttachments({
      messages: [message],
      workDir,
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: (msg) => logs.push(msg),
    });

    expect(result).toBe(false);
    expect(imagePartCount(message)).toBe(1);
    expect(readFileSync(externalMarker, 'utf8')).toBe('session-external');
    expect(readdirSync(externalSession)).toEqual(['marker.txt']);
    expect(lstatSync(path.join(imagesDir, 's1')).isSymbolicLink()).toBe(true);
    expect(logs.some((m) => m.includes('symlinked session'))).toBe(true);

    // Cleanup must not traverse the session symlink either.
    processImageAttachments({
      messages: [makeUserMsg([{ type: 'text', text: 'later' }])],
      workDir,
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: () => {},
    });
    expect(readdirSync(externalSession)).toEqual(['marker.txt']);
  });

  it('symlinked candidate filename advances to local suffix without writing through', () => {
    const workDir = path.join(TEST_DIR, 'symlink-candidate-file');
    const sessionDir = path.join(workDir, '.opencode', 'images', 's1');
    const externalFile = path.join(
      TEST_DIR,
      'symlink-candidate-file-external.bin',
    );
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(externalFile, 'do-not-overwrite');
    const candidateLink = path.join(sessionDir, IMG_CONTENT_NAME);
    symlinkSync(externalFile, candidateLink);

    const message = makeUserMsg([IMG]);
    processImageAttachments({
      messages: [message],
      workDir,
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: () => {},
    });

    // External target bytes must remain unchanged.
    expect(readFileSync(externalFile, 'utf8')).toBe('do-not-overwrite');
    expect(lstatSync(candidateLink).isSymbolicLink()).toBe(true);

    // Saved to a non-symlink collision name under the real session dir.
    const suffixed = path.join(sessionDir, `image-${IMG_HASH}-1.png`);
    expect(existsSync(suffixed)).toBe(true);
    expect(lstatSync(suffixed).isSymbolicLink()).toBe(false);
    expect(readFileSync(suffixed)).toEqual(IMG_BYTES);
    // Attachment replaced with observer nudge pointing at the local path.
    expect(imagePartCount(message)).toBe(0);
    const text = message.parts.find((p) => p.type === 'text')?.text ?? '';
    expect(text).toContain(suffixed);
  });

  it('git check-ignore treats images/ as ignored under .opencode', () => {
    const workDir = path.join(TEST_DIR, 'gitignore-check-ignore');
    mkdirSync(workDir, { recursive: true });

    const init = spawnSync('git', ['init'], {
      cwd: workDir,
      encoding: 'utf8',
    });
    if (init.status !== 0) {
      throw new Error(
        `git init failed (status=${init.status}): ${init.stderr}`,
      );
    }

    processImageAttachments({
      messages: [makeUserMsg([IMG])],
      workDir,
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: () => {},
    });

    const nestedImage = path.join(
      workDir,
      '.opencode',
      'images',
      's1',
      'probe.png',
    );
    mkdirSync(path.dirname(nestedImage), { recursive: true });
    writeFileSync(nestedImage, 'x');

    const configPath = path.join(
      workDir,
      '.opencode',
      'oh-my-opencode-slim.json',
    );
    writeFileSync(configPath, '{}');

    const ignored = spawnSync(
      'git',
      ['check-ignore', '-q', path.relative(workDir, nestedImage)],
      { cwd: workDir, encoding: 'utf8' },
    );
    expect(ignored.status).toBe(0);

    const configIgnored = spawnSync(
      'git',
      ['check-ignore', '-q', path.relative(workDir, configPath)],
      { cwd: workDir, encoding: 'utf8' },
    );
    // config must NOT be ignored (exit 1 = not ignored)
    expect(configIgnored.status).toBe(1);
  });

  it('resolves omitted image routing to auto and intercepts for Observer', () => {
    const message = makeUserMsg([IMG]);
    processImageAttachments({
      messages: [message],
      workDir: path.join(TEST_DIR, 'omitted-routing'),
      imageRouting: resolveImageRouting(undefined, true),
      disabledAgents: new Set<string>(),
      log: () => {},
    });
    expect(imagePartCount(message)).toBe(0);
    expect(message.parts.some((part) => part.type === 'text')).toBe(true);
  });

  it('returns true when observer disabled and message has images', () => {
    const message = makeUserMsg([IMG]);
    const result = processImageAttachments({
      messages: [message],
      workDir: path.join(TEST_DIR, 'disabled'),
      imageRouting: 'auto',
      disabledAgents: new Set(['observer']),
      log: () => {},
    });
    expect(result).toBe(true);
    expect(imagePartCount(message)).toBe(1);
  });

  it('returns false when observer disabled but no images present', () => {
    const message = makeUserMsg([{ type: 'text', text: 'hello' }]);
    const result = processImageAttachments({
      messages: [message],
      workDir: path.join(TEST_DIR, 'disabled-noimg'),
      imageRouting: 'auto',
      disabledAgents: new Set(['observer']),
      log: () => {},
    });
    expect(result).toBe(false);
  });

  it('returns true when observer disabled and an earlier (non-last) user message has images', () => {
    const earlierMsg = makeUserMsg([IMG]);
    const lastMsg = makeUserMsg([{ type: 'text', text: 'follow-up question' }]);
    const result = processImageAttachments({
      messages: [earlierMsg, lastMsg],
      workDir: path.join(TEST_DIR, 'earlier-image'),
      imageRouting: 'auto',
      disabledAgents: new Set(['observer']),
      log: () => {},
    });
    expect(result).toBe(true);
  });

  it('does not re-trigger on text-only messages after image was processed', () => {
    // Regression test: Greptile #1 fix checked ALL messages, causing the hook
    // to fire on every transform once an image was in the conversation history.
    const workDir = path.join(TEST_DIR, 'no-rere-trigger');
    const imageMsg = makeUserMsg([IMG]);
    const textMsg = makeUserMsg([{ type: 'text', text: 'follow-up' }]);

    // First call: image present → should return true
    const result1 = processImageAttachments({
      messages: [imageMsg, textMsg],
      workDir,
      imageRouting: 'auto',
      disabledAgents: new Set(['observer']),
      log: () => {},
    });
    expect(result1).toBe(true);

    // Second call: same messages, no new image → should return false
    const result2 = processImageAttachments({
      messages: [imageMsg, textMsg],
      workDir,
      imageRouting: 'auto',
      disabledAgents: new Set(['observer']),
      log: () => {},
    });
    expect(result2).toBe(false);
  });

  it('keeps images when auto mode cannot save them', () => {
    const message = makeUserMsg([
      { type: 'image', url: 'https://example.com/image.png' },
    ]);
    const logs: string[] = [];
    processImageAttachments({
      messages: [message],
      workDir: path.join(TEST_DIR, 'unsaved'),
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: (message) => logs.push(message),
    });
    expect(imagePartCount(message)).toBe(1);
    expect(message.parts).toHaveLength(1);
    expect(logs.some((message) => message.includes('[image-routing]'))).toBe(
      false,
    );
  });

  it('strips only attachments saved successfully', () => {
    const message = makeUserMsg([
      IMG,
      { type: 'image', url: 'https://example.com/image.png' },
    ]);
    processImageAttachments({
      messages: [message],
      workDir: path.join(TEST_DIR, 'mixed'),
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: () => {},
    });
    expect(imagePartCount(message)).toBe(1);
    expect(message.parts.some((part) => part.type === 'text')).toBe(true);
  });

  it('continues after an earlier message cannot save its images', () => {
    const failed = makeUserMsg([
      { type: 'image', url: 'https://example.com/image.png' },
    ]);
    const saved = makeUserMsg([IMG]);
    processImageAttachments({
      messages: [failed, saved],
      workDir: path.join(TEST_DIR, 'multiple'),
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: () => {},
    });
    expect(imagePartCount(failed)).toBe(1);
    expect(imagePartCount(saved)).toBe(0);
  });

  it('historical attachments reuse the memoized path without re-decoding', async () => {
    const { workDir } = makeTestDir('memo-reuse');
    const first = makeUserMsg([IMG]);
    processAuto([first], workDir);
    const marker = nudgeText(first).match(
      /(\/[^\s,]+image-[0-9a-f]{8}\.png)/,
    )?.[1];
    expect(marker).toBeDefined();
    const fromSpy = spyOn((await import('node:buffer')).Buffer, 'from');
    try {
      const second = makeUserMsg([IMG]);
      processAuto([second], workDir);
      expect(nudgeText(second)).toContain(marker as string);
      expect(fromSpy).not.toHaveBeenCalled();
    } finally {
      fromSpy.mockRestore();
    }
  });

  it('memoized attachment falls back to re-saving after deletion', () => {
    const { workDir, saveDir } = makeTestDir('memo-evict');
    processAuto([makeUserMsg([IMG])], workDir);
    for (const entry of readdirSync(saveDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        rmSync(path.join(saveDir, entry.name), {
          recursive: true,
          force: true,
        });
      }
    }
    const second = makeUserMsg([IMG]);
    processAuto([second], workDir);
    expect(imagePartCount(second)).toBe(0);
    expect(nudgeText(second)).toContain('image-');
  });

  it('same payload with different filenames resolves to different memo entries', () => {
    const { workDir } = makeTestDir('memo-filename');
    const before = makeUserMsg([{ type: 'image', url: IMG.url }]);
    const after = makeUserMsg([
      { type: 'image', url: IMG.url, filename: 'after.png' },
    ]);
    processAuto([before], workDir);
    processAuto([after], workDir);
    expect(nudgeText(before)).toContain('image-');
    expect(nudgeText(after)).toContain('after-');
  });

  it('suffixed resolution is not memoized: canonical path returns when obstacle is gone', () => {
    const { workDir } = makeTestDir('memo-suffix');
    const sessionDir = path.join(workDir, '.opencode', 'images', 's1');
    mkdirSync(sessionDir, { recursive: true });
    const canonical = path.join(sessionDir, IMG_CONTENT_NAME);
    const external = path.join(TEST_DIR, 'memo-suffix-external.bin');
    writeFileSync(external, 'external');
    symlinkSync(external, canonical);
    const first = makeUserMsg([IMG]);
    processAuto([first], workDir);
    expect(nudgeText(first)).toContain(`image-${IMG_HASH}-1.png`);
    rmSync(canonical);
    const second = makeUserMsg([IMG]);
    processAuto([second], workDir);
    expect(nudgeText(second)).toContain(IMG_CONTENT_NAME);
    expect(nudgeText(second)).not.toContain(`image-${IMG_HASH}-1.png`);
  });

  it('memo hit does not reuse a path replaced by a symlink', () => {
    const { workDir } = makeTestDir('memo-symlink');
    const first = makeUserMsg([IMG]);
    processAuto([first], workDir);
    const savedPath = nudgeText(first).match(
      /(\/[^\s,]+image-[0-9a-f]{8}\.png)/,
    )?.[1];
    expect(savedPath).toBeDefined();
    const external = path.join(TEST_DIR, 'memo-symlink-external.bin');
    writeFileSync(external, 'external');
    rmSync(savedPath as string);
    symlinkSync(external, savedPath as string);
    const second = makeUserMsg([IMG]);
    processAuto([second], workDir);
    const text = nudgeText(second);
    expect(text).not.toContain(savedPath as string);
    expect(text).toContain('image-');
    expect(lstatSync(savedPath as string).isSymbolicLink()).toBe(true);
    expect(readFileSync(external, 'utf8')).toBe('external');
  });

  it('ignores non-user messages and non-image parts', () => {
    const userText = makeUserMsg([{ type: 'text', text: 'hello' }]);
    const assistant = {
      info: { role: 'assistant', sessionID: 's1' },
      parts: [{ type: 'text', text: 'hi' }],
    } as unknown as MessageWithParts;
    processImageAttachments({
      messages: [userText, assistant],
      workDir: path.join(TEST_DIR, 'non-image'),
      imageRouting: 'auto',
      disabledAgents: new Set<string>(),
      log: () => {},
    });
    expect(userText.parts).toHaveLength(1);
    expect(assistant.parts).toHaveLength(1);
  });
});

describe('resolveImageRouting', () => {
  it('returns auto when omitted and observer enabled', () => {
    expect(resolveImageRouting(undefined, true)).toBe('auto');
  });

  it('returns direct when omitted and observer disabled', () => {
    expect(resolveImageRouting(undefined, false)).toBe('direct');
  });

  it('preserves explicit auto even when observer disabled', () => {
    expect(resolveImageRouting('auto', false)).toBe('auto');
  });

  it('preserves explicit direct even when observer enabled', () => {
    expect(resolveImageRouting('direct', true)).toBe('direct');
  });
});
