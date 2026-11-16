import { PANE_VIEWER_ENV } from '../multiplexer/shared';
import { attachTuiProcess } from './attachments';

export async function withTuiAttachment<T>(
  directory: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const previousViewer = process.env[PANE_VIEWER_ENV];
  delete process.env[PANE_VIEWER_ENV];
  const detach = attachTuiProcess(directory);
  try {
    return await run();
  } finally {
    detach();
    if (previousViewer === undefined) delete process.env[PANE_VIEWER_ENV];
    else process.env[PANE_VIEWER_ENV] = previousViewer;
  }
}
