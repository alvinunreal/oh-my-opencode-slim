import { join } from 'node:path';
import { getDataDir } from '../../cli/paths';

export const DEFAULT_REFRESH_INTERVAL_HOURS = 24;

export const MODEL_REFRESH_STATE_PATH = join(
  getDataDir(),
  'oh-my-opencode-slim-model-refresh.json',
);
