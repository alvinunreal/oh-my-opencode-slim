import type { AgentRole } from './config';

const RESEARCH_KEYWORDS = [
  'research',
  'find',
  'analyze',
  'best way',
  'should i',
  'how to',
  "what's the",
  'whats the',
  'compare',
  'recommend',
  'documentation',
  'docs',
  'learn',
  'understand',
];

const VALIDATION_KEYWORDS = [
  'test',
  'validate',
  'verify',
  'check',
  'ensure',
  'confirm',
];

const CODEBASE_KEYWORDS = [
  'where is',
  'find file',
  'locate',
  'search code',
  'grep',
  'files matching',
  'show me',
];

export interface TaskPlan {
  isTrivial: boolean;
  delegates: Array<{
    role: AgentRole;
    task: string;
    description: string;
  }>;
}

export function classifyAndRoute(userRequest: string): TaskPlan {
  const normalized = userRequest.toLowerCase().trim();

  if (isTrivialTask(normalized)) {
    return {
      isTrivial: true,
      delegates: [
        {
          role: 'IMPLEMENTER',
          task: userRequest,
          description: 'Single straightforward change',
        },
      ],
    };
  }

  const delegates: TaskPlan['delegates'] = [];

  if (needsResearch(normalized)) {
    delegates.push({
      role: 'RESEARCHER',
      task: extractResearchTask(userRequest),
      description: 'Research external documentation and resources',
    });
  }

  if (needsCodebaseAnalysis(normalized)) {
    delegates.push({
      role: 'REPO_SCOUT',
      task: extractCodebaseTask(userRequest),
      description: 'Analyze codebase to locate relevant files',
    });
  }

  if (!isPureResearch(normalized)) {
    delegates.push({
      role: 'IMPLEMENTER',
      task: userRequest,
      description: 'Implement the requested changes',
    });
  }

  if (needsValidation(normalized)) {
    delegates.push({
      role: 'VALIDATOR',
      task: `Test and verify: ${userRequest}`,
      description: 'Run tests and validate implementation',
    });
  }

  if (delegates.length === 0) {
    delegates.push({
      role: 'IMPLEMENTER',
      task: userRequest,
      description: 'Execute task',
    });
  }

  return {
    isTrivial: false,
    delegates,
  };
}

function isTrivialTask(request: string): boolean {
  const hasSingleFile =
    /^(?:change|fix|update|modify|edit|rename)\s+\w+\s+(?:in|at)\s+[\w/.-]+\.(?:ts|js|tsx|jsx|py|rs|go)/i.test(
      request,
    );

  const hasLineRef = /(?:line|lines?)\s*\d+/i.test(request);

  const isSimpleChange = /^(?:change|fix|update|rename)\s+\w+\s+to\s+\w+/i.test(
    request,
  );

  const hasNoResearch = !RESEARCH_KEYWORDS.some((kw) => request.includes(kw));

  const hasNoValidation = !VALIDATION_KEYWORDS.some((kw) =>
    request.includes(kw),
  );

  return (
    hasSingleFile &&
    hasLineRef &&
    isSimpleChange &&
    hasNoResearch &&
    hasNoValidation
  );
}

function needsResearch(request: string): boolean {
  return RESEARCH_KEYWORDS.some((kw) => request.includes(kw));
}

function needsCodebaseAnalysis(request: string): boolean {
  return CODEBASE_KEYWORDS.some((kw) => request.includes(kw));
}

function needsValidation(request: string): boolean {
  return VALIDATION_KEYWORDS.some((kw) => request.includes(kw));
}

function isPureResearch(request: string): boolean {
  const hasOnlyResearch = RESEARCH_KEYWORDS.some((kw) => request.includes(kw));
  const hasNoImplementation =
    !/^(?:implement|create|build|write|fix|update|change|modify|add|remove|delete)/i.test(
      request,
    );
  return hasOnlyResearch && hasNoImplementation;
}

function extractResearchTask(request: string): string {
  const match = request.match(
    /(?:research|find|analyze|how to|what's the|compare)\s+(.+?)(?:$|\s+(?:and|then|before|after))/i,
  );
  return match ? match[1].trim() : request;
}

function extractCodebaseTask(request: string): string {
  const match = request.match(
    /(?:where is|find file|locate|search|show me)\s+(.+?)(?:$|\s+(?:and|then|before|after))/i,
  );
  return match ? match[1].trim() : request;
}
