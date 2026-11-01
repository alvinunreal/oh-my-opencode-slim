import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveConfigWritePath } from '../config/write-path';
import { writeAtomic } from '../marketplace/lease';

export type ShellKind = 'bash' | 'fish' | 'zsh';

const ENV_NAME = 'OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS';
const EXA_ENV_NAME = 'OPENCODE_ENABLE_EXA';
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
  const home = env.HOME || homedir();
  if (shell === 'zsh') return join(env.ZDOTDIR || home, '.zshrc');
  if (shell === 'bash') return join(home, '.bashrc');
  if (shell === 'fish') {
    const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
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
  const commands = isFish
    ? `set -gx ${ENV_NAME} true\nset -gx ${EXA_ENV_NAME} 1`
    : `export ${ENV_NAME}=true\nexport ${EXA_ENV_NAME}=1`;

  return `${START_MARKER}\n${commands}\n${END_MARKER}`;
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
  const bashZshExaSnippet = `export ${EXA_ENV_NAME}=1`;
  const fishExaSnippet = `set -gx ${EXA_ENV_NAME} 1`;

  if (shell === 'fish') {
    return `Start OpenCode with background subagents and websearch enabled:\n  env ${ENV_NAME}=true ${EXA_ENV_NAME}=1 opencode\n\nOr add these to your fish startup file:\n  ${fishSnippet}\n  ${fishExaSnippet}`;
  }

  if (shell === 'bash' || shell === 'zsh') {
    return `Start OpenCode with background subagents and websearch enabled:\n  ${ENV_NAME}=true ${EXA_ENV_NAME}=1 opencode\n\nOr add these to your shell startup file:\n  ${bashZshSnippet}\n  ${bashZshExaSnippet}`;
  }

  return `Start OpenCode with background subagents and websearch enabled:\n  ${ENV_NAME}=true ${EXA_ENV_NAME}=1 opencode\n\nOr add the matching pair to your shell startup file:\n  bash/zsh: ${bashZshSnippet}\n            ${bashZshExaSnippet}\n  fish: ${fishSnippet}\n        ${fishExaSnippet}`;
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
  writeAtomic(resolveConfigWritePath(targetPath), nextContent);
}
