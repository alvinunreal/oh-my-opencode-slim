// Launched by tui-reusable-projection.test.ts as a second, live host process.
import { BackgroundJobBoard } from './background-job-fixture';
import { createTuiReusableProjection } from './tui-reusable-projection';

const projectDir = process.argv[2];
if (!projectDir) throw new Error('project directory required');
const board = new BackgroundJobBoard();
const projection = createTuiReusableProjection({ board, projectDir });
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
