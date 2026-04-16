import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// Debounce: only run cleanup every 10 minutes
let lastCleanup = 0;
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutes

interface ImagePart {
  type: string;
  url?: string;
  mime?: string;
  filename?: string;
  name?: string;
  [key: string]: unknown;
}

interface MessageWithParts {
  info: { role: string; agent?: string; sessionID?: string };
  parts: Array<{
    type: string;
    text?: string;
    [key: string]: unknown;
  }>;
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

export function processImageAttachments(args: {
  messages: MessageWithParts[];
  workDir: string;
  disabledAgents: Set<string>;
  log: (msg: string) => void;
}): void {
  const { messages, workDir, disabledAgents, log } = args;

  const observerEnabled = !disabledAgents.has('observer');
  if (!observerEnabled) return;

  // Save images inside the project's .opencode/images/ directory.
  // This is within the workspace so the read tool won't require extra permissions.
  const saveDir = join(workDir, '.opencode', 'images');
  const gitignorePath = join(workDir, '.opencode', '.gitignore');
  try {
    mkdirSync(saveDir, { recursive: true });
    if (!existsSync(gitignorePath)) writeFileSync(gitignorePath, '*\n');
  } catch (e) {
    log(`[image-hook] failed to create image directory: ${e}`);
  }

  // Clean up images older than 1 hour (debounced: only check every 10 minutes)
  const now = Date.now();
  if (now - lastCleanup > CLEANUP_INTERVAL) {
    lastCleanup = now;
    try {
      const maxAge = 60 * 60 * 1000;
      for (const f of readdirSync(saveDir)) {
        const fp = join(saveDir, f);
        try {
          if (now - statSync(fp).mtimeMs > maxAge) unlinkSync(fp);
        } catch {}
      }
    } catch {}
  }

  for (const msg of messages) {
    if (msg.info.role !== 'user') continue;
    const imageParts = msg.parts.filter(isImagePart);
    if (imageParts.length === 0) continue;

    // Save each image to .opencode/images/ and collect paths
    const savedPaths: string[] = [];
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
          const name = filename ?? `image-${hash}${extFromMime(decoded.mime)}`;
          const filePath = join(saveDir, name);
          try {
            writeFileSync(filePath, decoded.data);
            savedPaths.push(filePath);
          } catch (e) {
            log(`[image-hook] failed to save image: ${e}`);
          }
        }
      }
    }

    const pathsText =
      savedPaths.length > 0 ? ` Saved to: ${savedPaths.join(', ')}` : '';
    log(`[image-hook] stripping image/file parts, saving to disk${pathsText}`);

    msg.parts = msg.parts
      .filter((p) => !isImagePart(p as ImagePart))
      .concat([
        {
          type: 'text',
          text: `[Image attachment detected.${pathsText} Your model may not support image input. Delegate to @observer with the file path(s) above so it can read the file with its read tool.]`,
        },
      ]);
  }
}
