// Launched by tui-reusable-projection.test.ts as a second, live host process.
import { BackgroundJobBoard } from '../background-jobs';
import { createTuiReusableProjection } from './tui-reusable-projection';

const projectDir = process.argv[2];
if (!projectDir) throw new Error('project directory required');
const backgroundJobs = new BackgroundJobBoard();
const projection = createTuiReusableProjection({
  board: backgroundJobs,
  projectDir,
});
const board = backgroundJobs;
board.registerLaunch({
  taskID: 'ses_child',
  parentSessionID: 'parent-child',
  agent: 'fixer',
});
process.stdout.write('ready\n');

for await (const _chunk of process.stdin) {
  board.registerLaunch({
    taskID: 'ses_child_2',
    parentSessionID: 'parent-child',
    agent: 'fixer',
  });
  process.stdout.write('mutated\n');
}
projection.dispose();
