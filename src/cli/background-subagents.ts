import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type BackgroundSubagentsMode = 'ask' | 'yes' | 'no';
export type ShellKind = 'bash' | 'fish' | 'zsh';

const ENV_NAME = 'OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS';
const START_MARKER = '# >>> oh-my-opencode-slim background subagents >>>';
const END_MARKER = '# <<< oh-my-opencode-slim background subagents <<<';

export function isBackgroundSubagentsEnabled(
  value: string | undefined,
): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && !['0', 'false', 'no', 'off'].includes(normalized);
}

export function detectShellKind(
  shell: string | undefined,
): ShellKind | undefined {
  const name = shell?.split('/').at(-1);
  if (name === 'zsh' || name === 'bash' || name === 'fish') return name;
  return undefined;
}

export function detectBackgroundSubagentsTarget(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const shell = detectShellKind(env.SHELL);
  if (shell === 'zsh') return join(homedir(), '.zshrc');
  if (shell === 'bash') return join(homedir(), '.bashrc');
  if (shell === 'fish') {
    const configHome = env.XDG_CONFIG_HOME || join(homedir(), '.config');
    return join(
      configHome,
      'fish',
      'conf.d',
      'opencode-background-subagents.fish',
    );
  }
  return undefined;
}

export function getBackgroundSubagentsBlock(targetPath: string): string {
  const isFish = targetPath.endsWith('.fish');
  const command = isFish
    ? `set -gx ${ENV_NAME} true`
    : `export ${ENV_NAME}=true`;

  return `${START_MARKER}\n${command}\n${END_MARKER}`;
}

export function manualBackgroundSubagentsInstructions(options?: {
  targetPath?: string;
  shell?: ShellKind;
}): string {
  const shell =
    options?.shell ??
    (options?.targetPath?.endsWith('.fish') ? 'fish' : undefined) ??
    detectShellKind(options?.targetPath);
  const bashZshSnippet = `export ${ENV_NAME}=true`;
  const fishSnippet = `set -gx ${ENV_NAME} true`;

  if (shell === 'fish') {
    return `Start OpenCode with background subagents enabled:\n  env ${ENV_NAME}=true opencode\n\nOr add this to your fish startup file:\n  ${fishSnippet}`;
  }

  if (shell === 'bash' || shell === 'zsh') {
    return `Start OpenCode with background subagents enabled:\n  ${ENV_NAME}=true opencode\n\nOr add this to your shell startup file:\n  ${bashZshSnippet}`;
  }

  return `Start OpenCode with background subagents enabled:\n  ${ENV_NAME}=true opencode\n\nOr add one of these to your shell startup file:\n  bash/zsh: ${bashZshSnippet}\n  fish: ${fishSnippet}`;
}

export function expandHomePath(targetPath: string): string {
  if (targetPath === '~') return homedir();
  if (targetPath.startsWith('~/')) return join(homedir(), targetPath.slice(2));
  return targetPath;
}

export function upsertBackgroundSubagentsBlock(
  content: string,
  block: string,
): string {
  const start = content.indexOf(START_MARKER);
  const end = content.indexOf(END_MARKER);

  if (start !== -1 && end !== -1 && end > start) {
    const afterEnd = end + END_MARKER.length;
    return `${content.slice(0, start)}${block}${content.slice(afterEnd)}`;
  }

  const separator = content.length > 0 && !content.endsWith('\n') ? '\n\n' : '';
  const prefix =
    content.length > 0 && content.endsWith('\n') ? '\n' : separator;
  return `${content}${prefix}${block}\n`;
}

export function writeBackgroundSubagentsBlock(targetPath: string): void {
  const block = getBackgroundSubagentsBlock(targetPath);
  const content = existsSync(targetPath)
    ? readFileSync(targetPath, 'utf8')
    : '';
  const nextContent = upsertBackgroundSubagentsBlock(content, block);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, nextContent);
}
