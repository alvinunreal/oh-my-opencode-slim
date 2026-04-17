import path from 'node:path';

export function tryDecodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function encodeBytesIdentity(bytes: Uint8Array): string {
  return `bytes:base64:${Buffer.from(bytes).toString('base64')}`;
}

export function getDisplayPath(absolutePath: string, worktree: string): string {
  const root = path.parse(worktree).root;
  if (worktree === root) {
    return absolutePath;
  }

  const relative = path.relative(worktree, absolutePath);
  if (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  ) {
    return relative;
  }

  return absolutePath;
}

export function resolveAbsolutePath(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

export function stripSingleLineEnding(value: string): string {
  return value.replace(/\r$/, '');
}

export function normalizeDisplayText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function sanitizeTitle(value: string, maxLength = 160): string {
  const singleLine = escapeControlChars(
    normalizeDisplayText(value).replace(/\s+/g, ' ').trim(),
  );
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, Math.max(1, maxLength - 3))}...`;
}

export function escapeControlChars(value: string): string {
  let output = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code === 0x0d) {
      output += '\\r';
    } else if (code === 0x0a) {
      output += '\\n';
    } else if (code === 0x09) {
      output += '\\t';
    } else if (code < 0x20 || code === 0x7f) {
      output += `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      output += char;
    }
  }
  return output;
}

export function escapeControlCharsPreservingNewlines(value: string): string {
  let output = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code === 0x0d) {
      output += '\\r';
    } else if (code === 0x09) {
      output += '\\t';
    } else if ((code < 0x20 || code === 0x7f) && code !== 0x0a) {
      output += `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      output += char;
    }
  }
  return output;
}

export function escapePathBytes(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) {
    if (byte === 0x0a) {
      output += '\\n';
      continue;
    }
    if (byte === 0x0d) {
      output += '\\r';
      continue;
    }
    if (byte === 0x09) {
      output += '\\t';
      continue;
    }
    if (byte >= 0x20 && byte <= 0x7e) {
      output += String.fromCharCode(byte);
      continue;
    }
    output += `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return output;
}

export function escapeBinaryText(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) {
    if (byte === 0x0a) {
      output += '\n';
      continue;
    }
    if (byte === 0x0d) {
      output += '\r';
      continue;
    }
    if (byte === 0x09) {
      output += '\t';
      continue;
    }
    if (byte >= 0x20 && byte <= 0x7e) {
      output += String.fromCharCode(byte);
      continue;
    }
    output += `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return output;
}

export function formatNonUtf8TextDisplay(bytes: Uint8Array): string {
  return `${escapeBinaryText(bytes)} [${encodeBytesIdentity(bytes)}]`;
}

export function formatNonUtf8PathDisplay(
  displayBytes: Uint8Array,
  identityBytes = displayBytes,
): string {
  return `${escapePathBytes(displayBytes)} [${encodeBytesIdentity(identityBytes)}]`;
}

function startsWithBytes(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length > bytes.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) {
      return false;
    }
  }
  return true;
}

type BytePathStyle = 'posix' | 'windows';

function looksWindowsText(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function getBytePathStyle(
  rawBytes: Uint8Array,
  cwd: string,
  worktree: string,
): BytePathStyle {
  if (looksWindowsText(cwd) || looksWindowsText(worktree)) {
    return 'windows';
  }

  if (
    isAlphaByte(rawBytes[0]) &&
    rawBytes[1] === 0x3a &&
    (rawBytes[2] === 0x2f || rawBytes[2] === 0x5c)
  ) {
    return 'windows';
  }

  if (rawBytes[0] === 0x5c && rawBytes[1] === 0x5c) {
    return 'windows';
  }

  return 'posix';
}

function isSepByte(byte: number | undefined, style: BytePathStyle): boolean {
  if (style === 'windows') {
    return byte === 0x2f || byte === 0x5c;
  }

  return byte === 0x2f;
}

function isAlphaByte(byte: number | undefined): boolean {
  return (
    byte !== undefined &&
    ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a))
  );
}

function isAbsoluteBytes(bytes: Uint8Array, style: BytePathStyle): boolean {
  if (bytes.length === 0) {
    return false;
  }

  if (style === 'posix') {
    return bytes[0] === 0x2f;
  }

  if (isSepByte(bytes[0], style)) {
    return true;
  }

  return (
    isAlphaByte(bytes[0]) && bytes[1] === 0x3a && isSepByte(bytes[2], style)
  );
}

function pickSeparatorByte(
  base: Uint8Array,
  value: Uint8Array,
  style: BytePathStyle,
): number {
  if (style === 'windows' && (base.includes(0x5c) || value.includes(0x5c))) {
    return 0x5c;
  }

  return 0x2f;
}

function isRootPathText(value: string, style: BytePathStyle): boolean {
  if (style === 'windows') {
    return (
      /^[a-zA-Z]:[\\/]$/.test(value) ||
      /^\\\\[^\\/]+[\\/][^\\/]+[\\/]?$/.test(value)
    );
  }

  return value === '/';
}

function trimTrailingSeparators(value: string, style: BytePathStyle): string {
  if (value.length === 0 || isRootPathText(value, style)) {
    return value;
  }

  let end = value.length;
  while (end > 0) {
    const char = value[end - 1];
    const isSep =
      style === 'windows' ? char === '/' || char === '\\' : char === '/';
    if (!isSep) {
      break;
    }

    const candidate = value.slice(0, end);
    if (isRootPathText(candidate, style)) {
      break;
    }

    end -= 1;
  }

  return value.slice(0, end);
}

function hasPathPrefixBytes(
  bytes: Uint8Array,
  prefix: Uint8Array,
  style: BytePathStyle,
): boolean {
  if (!startsWithBytes(bytes, prefix)) {
    return false;
  }

  if (bytes.length === prefix.length) {
    return true;
  }

  if (isSepByte(prefix[prefix.length - 1], style)) {
    return true;
  }

  return isSepByte(bytes[prefix.length], style);
}

function joinPathBytes(
  base: Uint8Array,
  value: Uint8Array,
  style: BytePathStyle,
): Uint8Array {
  if (base.length === 0) {
    return Buffer.from(value);
  }

  if (isSepByte(base[base.length - 1], style)) {
    return Buffer.concat([Buffer.from(base), Buffer.from(value)]);
  }

  return Buffer.concat([
    Buffer.from(base),
    Buffer.from([pickSeparatorByte(base, value, style)]),
    Buffer.from(value),
  ]);
}

export function buildPathFromBytes(
  rawBytes: Uint8Array,
  cwd: string,
  worktree: string,
): {
  absolutePath: string;
  displayPath: string;
  replayPath?: string;
  nonUtf8Path: boolean;
  pathKey: string;
} {
  const decoded = tryDecodeUtf8(rawBytes);
  if (decoded !== undefined) {
    const absolutePath = resolveAbsolutePath(decoded, cwd);
    return {
      absolutePath,
      displayPath: getDisplayPath(absolutePath, worktree),
      replayPath: absolutePath,
      nonUtf8Path: false,
      pathKey: `utf8:${absolutePath}`,
    };
  }

  const style = getBytePathStyle(rawBytes, cwd, worktree);
  const normalizedCwd = trimTrailingSeparators(cwd, style);
  const normalizedWorktree = trimTrailingSeparators(worktree, style);
  const cwdBytes = Buffer.from(normalizedCwd);
  const absoluteBytes = isAbsoluteBytes(rawBytes, style)
    ? Buffer.from(rawBytes)
    : joinPathBytes(cwdBytes, rawBytes, style);
  const worktreeBytes = Buffer.from(normalizedWorktree);
  const absoluteIdentity = encodeBytesIdentity(absoluteBytes);
  const worktreeRoot = isRootPathText(normalizedWorktree, style);
  const relativeBytes = hasPathPrefixBytes(absoluteBytes, worktreeBytes, style)
    ? absoluteBytes.subarray(
        worktreeBytes.length +
          (isSepByte(absoluteBytes[worktreeBytes.length], style) ? 1 : 0),
      )
    : absoluteBytes;
  const displayPath = worktreeRoot
    ? formatNonUtf8PathDisplay(absoluteBytes, absoluteBytes)
    : formatNonUtf8PathDisplay(relativeBytes, absoluteBytes);

  return {
    absolutePath: absoluteIdentity,
    displayPath,
    nonUtf8Path: true,
    pathKey: absoluteIdentity,
  };
}
