import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import { log } from '../utils/logger';
import { isUserMessageWithParts, type MessageWithParts } from './types';

// Debounce: only run cleanup every 10 minutes per directory
const lastCleanupByDir = new Map<string, number>();
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutes

// Track how many user messages we've already checked for images per directory.
// Without this, the observer-disabled guard re-checks ALL messages on every
// transform. Once an image is sent, it stays in the messages array forever,
// causing the hook to fire on every subsequent text-only message. This
// suppresses duplicate toasts while still catching images in non-last messages
// (Greptile #1 fix).
const lastProcessedUserMsgCountByDir = new Map<string, number>();

interface ImagePart {
  type: string;
  url?: string;
  mime?: string;
  filename?: string;
  name?: string;
  [key: string]: unknown;
}

function isImagePart(p: ImagePart): boolean {
  if (p.type === 'image') return true;
  if (p.type === 'file') {
    const mime = p.mime as string | undefined;
    if (mime?.startsWith('image/')) return true;
    const filename = p.filename as string | undefined;
    const name = p.name as string | undefined;
    const fileName = filename ?? name;
    if (
      fileName &&
      /\.(png|jpg|jpeg|gif|bmp|webp|svg|ico|tiff?|heic)$/i.test(fileName)
    )
      return true;
  }
  return false;
}

function decodeDataUrl(url: string): { mime: string; data: Buffer } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mime: match[1], data: Buffer.from(match[2], 'base64') };
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp',
  };
  return map[mime] ?? '.png';
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function cleanupAllSessions(saveDir: string): void {
  const now = Date.now();
  const lastCleanup = lastCleanupByDir.get(saveDir) ?? 0;
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanupByDir.set(saveDir, now);

  const maxAge = 60 * 60 * 1000;
  const dirsToScan: string[] = [];

  // Collect saveDir itself (for non-session images) + all session subdirs
  try {
    for (const entry of readdirSync(saveDir, { withFileTypes: true })) {
      const fp = join(saveDir, entry.name);
      if (entry.isDirectory()) {
        dirsToScan.push(fp);
      } else {
        try {
          if (now - statSync(fp).mtimeMs > maxAge) unlinkSync(fp);
        } catch (err) {
          log('[image-hook] file cleanup failed', String(err));
        }
      }
    }
  } catch (err) {
    log('[image-hook] directory scan failed', String(err));
  }

  for (const dir of dirsToScan) {
    try {
      let isEmpty = true;
      let allRemoved = true;
      for (const f of readdirSync(dir)) {
        isEmpty = false;
        const fp = join(dir, f);
        try {
          if (now - statSync(fp).mtimeMs > maxAge) {
            unlinkSync(fp);
          } else {
            allRemoved = false;
          }
        } catch (err) {
          log('[image-hook] file cleanup failed', String(err));
          allRemoved = false;
        }
      }
      // Remove session subdirectory only if it had files and all were expired
      if (!isEmpty && allRemoved) {
        try {
          rmdirSync(dir);
        } catch (err) {
          log('[image-hook] directory removal failed', String(err));
        }
      }
    } catch (err) {
      log('[image-hook] session cleanup failed', String(err));
    }
  }
}

function writeUniqueFile(
  dir: string,
  name: string,
  data: Buffer,
  log: (msg: string) => void,
): string | null {
  const ext = extname(name);
  const base = basename(name, ext) || name;
  let candidate = join(dir, name);
  if (existsSync(candidate)) {
    return candidate;
  }
  let counter = 0;

  const MAX_ATTEMPTS = 1000;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
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

      log(`[image-hook] failed to save image: ${e}`);
      return null;
    }
  }

  log(
    `[image-hook] failed to save image: max attempts (${MAX_ATTEMPTS}) reached`,
  );
  return null;
}

export function processImageAttachments(args: {
  messages: MessageWithParts[];
  workDir: string;
  imageRouting: 'auto' | 'direct';
  disabledAgents: Set<string>;
  log: (msg: string) => void;
}): boolean {
  const { messages, workDir, imageRouting, disabledAgents, log } = args;

  // direct mode: never intercept attachments; the orchestrator handles them
  // inline. @observer remains available for manual delegation.
  if (imageRouting === 'direct') {
    return false;
  }

  // auto mode: observer must be enabled (enforced at config load). Retain
  // this guard as defense-in-depth in case validation is bypassed.
  const observerEnabled = !disabledAgents.has('observer');
  if (!observerEnabled) {
    // Check only NEW user messages for images. We track how many user messages
    // we've already processed per session. Without this, the guard re-checks
    // ALL messages on every transform — once an image is sent, it stays in the
    // messages array forever, causing the hook to fire on every subsequent
    // text-only message (regression from Greptile #1 fix).
    //
    // Keyed by workDir:sessionID so multiple sessions in the same project
    // don't collide (Greptile P1: "Scope tracking by conversation").
    const firstUserMsg = messages.find(isUserMessageWithParts);
    const sessionId = firstUserMsg?.info.sessionID ?? 'default';
    const counterKey = `${workDir}:${sessionId}`;
    const userMsgCount = messages.filter(isUserMessageWithParts).length;
    let lastProcessed = lastProcessedUserMsgCountByDir.get(counterKey) ?? 0;
    // ponytail: reset after history compaction; re-checking old messages is harmless
    if (userMsgCount < lastProcessed) {
      lastProcessed = 0;
      lastProcessedUserMsgCountByDir.set(counterKey, 0);
    }
    if (userMsgCount > lastProcessed) {
      // Check only the new user messages (those we haven't seen yet)
      let userIndex = 0;
      for (const msg of messages) {
        if (!isUserMessageWithParts(msg)) continue;
        if (userIndex >= lastProcessed) {
          // This is a new user message — check for images
          if (msg.parts.some(isImagePart)) {
            log('[image-hook] dropped images: observer disabled');
            lastProcessedUserMsgCountByDir.set(counterKey, userMsgCount);
            return true;
          }
        }
        userIndex++;
      }
      // No images in new messages — update counter so we don't re-check them
      lastProcessedUserMsgCountByDir.set(counterKey, userMsgCount);
    }
    return false;
  }

  const messagesWithImages: Array<{
    msg: MessageWithParts;
    imageParts: ImagePart[];
  }> = [];

  for (const msg of messages) {
    if (!isUserMessageWithParts(msg)) continue;
    const imageParts = msg.parts.filter(isImagePart);
    if (imageParts.length > 0) {
      messagesWithImages.push({ msg, imageParts });
    }
  }

  // Save images inside the project's .opencode/images/ directory.
  // This is within the workspace so the read tool won't require extra permissions.
  const saveDir = join(workDir, '.opencode', 'images');

  if (messagesWithImages.length === 0) {
    if (existsSync(saveDir)) cleanupAllSessions(saveDir);
    return false;
  }

  const gitignorePath = join(workDir, '.opencode', '.gitignore');
  try {
    mkdirSync(saveDir, { recursive: true });
    if (!existsSync(gitignorePath)) writeFileSync(gitignorePath, '*\n');
  } catch (e) {
    log(`[image-hook] failed to create image directory: ${e}`);
  }

  cleanupAllSessions(saveDir);

  for (const { msg, imageParts } of messagesWithImages) {
    const sessionSubdir = msg.info.sessionID
      ? sanitizeFilename(msg.info.sessionID)
      : undefined;
    const targetDir = sessionSubdir ? join(saveDir, sessionSubdir) : saveDir;
    try {
      mkdirSync(targetDir, { recursive: true });
    } catch (e) {
      log(`[image-hook] failed to create target image directory: ${e}`);
    }

    // Save each image to .opencode/images/ and collect paths
    const savedPaths: string[] = [];
    const savedImageParts = new Set<ImagePart>();
    for (const p of imageParts) {
      const url = p.url as string | undefined;
      const filename =
        (p.filename as string | undefined) ?? (p.name as string | undefined);
      if (url) {
        const decoded = decodeDataUrl(url);
        if (decoded) {
          const hash = createHash('sha1')
            .update(decoded.data)
            .digest('hex')
            .slice(0, 8);
          const sanitizedFilename = filename
            ? sanitizeFilename(filename)
            : undefined;
          const baseName = sanitizedFilename
            ? sanitizedFilename.replace(/\.[^.]+$/, '') || 'image'
            : 'image';
          const ext = sanitizedFilename
            ? extname(sanitizedFilename) || extFromMime(decoded.mime)
            : extFromMime(decoded.mime);
          const name = `${baseName}-${hash}${ext}`;
          const filePath = writeUniqueFile(targetDir, name, decoded.data, log);
          if (filePath) {
            savedPaths.push(filePath);
            savedImageParts.add(p);
          }
        }
      }
    }

    // If no image could be saved, do not strip the parts: the orchestrator
    // would receive a nudge with no usable path and the bytes would be lost.
    if (savedPaths.length === 0) {
      log('[image-hook] no images saved; leaving original parts in message');
      continue;
    }

    const pathsText = ` Saved to: ${savedPaths.join(', ')}`;
    log(`[image-hook] saved image/file parts to disk${pathsText}`);
    log(
      `[image-routing] auto mode: intercepted ${savedImageParts.size} image(s), delegating to @observer`,
    );

    msg.parts = msg.parts
      .filter((p) => !savedImageParts.has(p as ImagePart))
      .concat([
        {
          type: 'text',
          text: `[Image attachment detected.${pathsText} Your model may not support image input. Delegate to @observer with the file path(s) above so it can read the file with its read tool.]`,
        },
      ]);
  }
  return false;
}
