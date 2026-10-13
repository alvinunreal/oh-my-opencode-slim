import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import { asImagePart, type ImagePartView } from './image-part';
import { isUserMessageWithParts, type MessageWithParts } from './types';

/** Keep this aligned with the host read tool's MAX_MEDIA_INGEST_BYTES. */
const MAX_MEDIA_INGEST_BYTES = 20 * 1024 * 1024;
const IMAGES_GITIGNORE_RULE = 'images/';
const IMAGES_GITIGNORE_BYTES = Buffer.from(`${IMAGES_GITIGNORE_RULE}\n`);

function opencodeDirPath(workDir: string): string {
  return join(workDir, '.opencode');
}

function opencodeGitignorePath(workDir: string): string {
  return join(opencodeDirPath(workDir), '.gitignore');
}

function imagesDirPath(workDir: string): string {
  return join(opencodeDirPath(workDir), 'images');
}

function pathIsSymlink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function isRegularFile(target: string): boolean {
  try {
    return lstatSync(target).isFile();
  } catch {
    return false;
  }
}

function isUnsafeOpencodeGitignorePath(workDir: string): boolean {
  return (
    pathIsSymlink(opencodeDirPath(workDir)) ||
    pathIsSymlink(opencodeGitignorePath(workDir))
  );
}

function isUnsafeImageSavePath(workDir: string): boolean {
  return (
    pathIsSymlink(opencodeDirPath(workDir)) ||
    pathIsSymlink(imagesDirPath(workDir))
  );
}

function gitignoreHasExactRule(content: string, rule: string): boolean {
  return content.split(/\r?\n/).includes(rule);
}

/**
 * Protect only the generated images directory. Called once per image-bearing
 * transform before any write, so persisted images are never left un-ignored;
 * direct routing and text-only messages never reach this.
 */
function ensureImagesGitignore(
  workDir: string,
  logFn: (msg: string) => void,
): boolean {
  const gitignorePath = opencodeGitignorePath(workDir);
  try {
    if (isUnsafeOpencodeGitignorePath(workDir)) {
      logFn('[image-hook] refusing to update symlinked .opencode/.gitignore');
      return false;
    }

    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, IMAGES_GITIGNORE_BYTES);
      return true;
    }

    const raw = readFileSync(gitignorePath);
    if (gitignoreHasExactRule(raw.toString('utf8'), IMAGES_GITIGNORE_RULE)) {
      return true;
    }

    const needsNewline = raw.length > 0 && raw[raw.length - 1] !== 0x0a;
    const suffix = needsNewline
      ? Buffer.from(`\n${IMAGES_GITIGNORE_RULE}\n`)
      : IMAGES_GITIGNORE_BYTES;
    appendFileSync(gitignorePath, suffix);
    return true;
  } catch (error) {
    logFn(`[image-hook] failed to update .gitignore: ${error}`);
    return false;
  }
}

export function isImagePart(p: unknown): boolean {
  return asImagePart(p) !== null;
}
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Save a content-addressed image with an exclusive create. The filename is
 * the content digest, so an existing path is the durable dedup memo: reuse it
 * without rewriting.
 */
function writeUniqueFile(
  dir: string,
  name: string,
  data: Buffer,
  log: (msg: string) => void,
): string | null {
  const ext = extname(name);
  const base = basename(name, ext) || name;
  let candidate = join(dir, name);
  let counter = 0;

  const MAX_ATTEMPTS = 1000;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Never treat a symlink as an already-saved image and never write through
    // it. Advance to the next collision name instead.
    if (pathIsSymlink(candidate)) {
      counter += 1;
      candidate = join(dir, `${base}-${counter}${ext}`);
      continue;
    }

    // Existing regular file at this content-addressed name: reuse the path.
    // A non-file entry (directory, fifo, ...) squatting on the name is not a
    // saved image; advance to the next collision name instead of reusing it.
    if (existsSync(candidate)) {
      if (isRegularFile(candidate)) {
        return candidate;
      }
      counter += 1;
      candidate = join(dir, `${base}-${counter}${ext}`);
      continue;
    }

    try {
      writeFileSync(candidate, data, { flag: 'wx' });
      return candidate;
    } catch (e) {
      if (
        e instanceof Error &&
        (e as NodeJS.ErrnoException).code === 'EEXIST'
      ) {
        counter += 1;
        candidate = join(dir, `${base}-${counter}${ext}`);
        continue;
      }

      // A failed write can leave a truncated file at the content-addressed
      // path; remove it so a later transform never reuses corrupt bytes.
      try {
        unlinkSync(candidate);
      } catch {
        // Best effort: nothing was created, or it is already gone.
      }
      log(`[image-hook] failed to save image: ${e}`);
      return null;
    }
  }

  log(
    `[image-hook] failed to save image: max attempts (${MAX_ATTEMPTS}) reached`,
  );
  return null;
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function processImageAttachments(args: {
  messages: MessageWithParts[];
  workDir: string;
  imageRouting: 'auto' | 'direct';
  disabledAgents: ReadonlySet<string>;
  /** Whether the turn's model accepts image input, from the host-resolved
   * capabilities. Unknown (`undefined`) falls through to interception. */
  modelAcceptsImages?: boolean;
  log: (msg: string) => void;
}): boolean {
  const { messages, workDir, imageRouting, disabledAgents, log } = args;

  // direct mode: never intercept attachments; the orchestrator handles them
  // inline. @observer remains available for manual delegation.
  if (imageRouting === 'direct') return false;

  // auto + the turn's model accepts image input: native vision wins — keep
  // the parts inline and let the model read them directly.
  if (args.modelAcceptsImages === true) return false;

  // Keep original parts when observer is unavailable. The caller displays a
  // debounced warning toast; this hook must never destroy user data.
  if (disabledAgents.has('observer')) {
    const userMessages = messages.filter(isUserMessageWithParts);
    const latestUserMessage = userMessages[userMessages.length - 1];
    if (latestUserMessage?.parts.some(isImagePart)) {
      log(
        '[image-hook] images retained inline; observer disabled — enable observer or set image_routing "direct"',
      );
      return true;
    }
    return false;
  }

  // One seam for every host shape: v1 file/image data URLs, flat v2 media,
  // and v2.0.14+ Media.Asset instances (live or JSON-replayed). The view is
  // computed once here and consumed by the save loop below, so each part is
  // decoded exactly once per transform.
  const messagesWithImages: Array<{
    msg: MessageWithParts;
    imageParts: Array<{ part: unknown; view: ImagePartView }>;
  }> = [];

  for (const msg of messages) {
    if (!isUserMessageWithParts(msg)) continue;
    const imageParts: Array<{ part: unknown; view: ImagePartView }> = [];
    for (const part of msg.parts) {
      const view = asImagePart(part);
      if (view) imageParts.push({ part, view });
    }
    if (imageParts.length > 0) {
      messagesWithImages.push({ msg, imageParts });
    }
  }

  if (messagesWithImages.length === 0) return false;

  // Remote-only transforms (https URLs, Asset url/ref sources) carry nothing
  // to save: skip all filesystem setup and leave the parts inline — the
  // host's capability replacement is the backstop.
  const hasMaterializable = messagesWithImages.some(({ imageParts }) =>
    imageParts.some(({ view }) => view.view === 'bytes'),
  );
  if (!hasMaterializable) return false;

  const saveDir = imagesDirPath(workDir);
  if (isUnsafeImageSavePath(workDir)) {
    log('[image-hook] refusing to write via symlinked .opencode/images path');
    return false;
  }

  try {
    mkdirSync(saveDir, { recursive: true });
  } catch (error) {
    log(`[image-hook] failed to create image directory: ${error}`);
  }

  // Persist images only when the images directory is git-ignored. Ensuring
  // once per image-bearing transform (before any write) keeps reused images
  // protected and guarantees a failed ensure leaves zero files behind.
  if (!ensureImagesGitignore(workDir, log)) {
    log('[image-hook] images kept inline: .gitignore protection failed');
    return false;
  }

  for (const { msg, imageParts } of messagesWithImages) {
    const sessionSubdir = msg.info.sessionID
      ? sanitizeFilename(msg.info.sessionID)
      : undefined;
    const targetDir = sessionSubdir ? join(saveDir, sessionSubdir) : saveDir;

    if (pathIsSymlink(targetDir)) {
      log(
        `[image-hook] refusing to write via symlinked session image directory: ${targetDir}`,
      );
      continue;
    }

    try {
      mkdirSync(targetDir, { recursive: true });
    } catch (error) {
      log(`[image-hook] failed to create target image directory: ${error}`);
    }

    const savedPaths: string[] = [];
    const oversizedPaths = new Map<string, number>();
    const savedImageParts = new Set<unknown>();

    const saveDecoded = (
      part: unknown,
      data: Buffer,
      ext: string,
      baseName: string,
    ): void => {
      const hash = createHash('sha1').update(data).digest('hex').slice(0, 8);
      const name = `${baseName}-${hash}${ext}`;
      const filePath = writeUniqueFile(targetDir, name, data, log);
      if (!filePath) return;

      savedPaths.push(filePath);
      savedImageParts.add(part);
      if (data.length > MAX_MEDIA_INGEST_BYTES) {
        oversizedPaths.set(filePath, data.length);
      }
    };

    for (const { part, view } of imageParts) {
      // Parts the adapter cannot materialize (remote sources, malformed
      // carriers) are never stripped; the host's capability replacement is
      // the backstop.
      if (view.view !== 'bytes') continue;
      const rawName = view.filename;
      const sanitized = rawName ? sanitizeFilename(rawName) : undefined;
      const baseName = sanitized
        ? sanitized.replace(/\.[^.]+$/, '') || 'image'
        : 'image';
      saveDecoded(part, view.bytes, view.ext, baseName);
    }

    // If no image could be saved, leave every original part in place. This is
    // the fail-open contract for malformed data, permissions, and NFS errors.
    if (savedPaths.length === 0) {
      log('[image-hook] no images saved; leaving original parts in message');
      continue;
    }

    const readablePaths = savedPaths.filter(
      (filePath) => !oversizedPaths.has(filePath),
    );
    const nudgeSections: string[] = [];
    if (readablePaths.length > 0) {
      nudgeSections.push(
        `Image saved to:\n${readablePaths.map((p) => `- ${p}`).join('\n')}\nDelegate to @observer with the path(s) and your goal — @observer reads images with its read tool.`,
      );
    }
    if (oversizedPaths.size > 0) {
      nudgeSections.push(
        `Too large for the read tool (20 MiB) — do not delegate; ask the user to compress or crop:\n${[
          ...oversizedPaths.entries(),
        ]
          .map(([p, size]) => `- ${p} (${formatMiB(size)})`)
          .join('\n')}`,
      );
    }

    log(
      `[image-routing] auto mode: intercepted ${savedImageParts.size} image(s), delegating ${readablePaths.length}`,
    );

    msg.parts = msg.parts
      .filter((p) => !savedImageParts.has(p))
      .concat([
        {
          type: 'text',
          text: `[${nudgeSections.join('\n')}]`,
        },
      ]);
  }
  return false;
}
