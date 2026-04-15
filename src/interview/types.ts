import { z } from 'zod';

export interface InterviewQuestion {
  id: string;
  question: string;
  options: string[];
  suggested?: string;
}

export interface InterviewAnswer {
  questionId: string;
  answer: string;
}

export interface InterviewAssistantState {
  summary: string;
  title?: string;
  questions: InterviewQuestion[];
}

// ─── Zod Schemas (for validating untrusted LLM output) ─────────────

/** Raw question object from LLM output — loose, everything optional. */
export const RawQuestionSchema = z.object({
  id: z.string().optional(),
  question: z.string().optional(),
  options: z.array(z.unknown()).optional(),
  suggested: z.unknown().optional(),
});

/** Raw interview_state block from LLM output. */
export const RawInterviewStateSchema = z.object({
  summary: z.unknown().optional(),
  title: z.unknown().optional(),
  questions: z.array(z.unknown()).optional(),
});

// ─── Interfaces ─────────────────────────────────────────────────────

export interface InterviewRecord {
  id: string;
  sessionID: string;
  idea: string;
  markdownPath: string;
  createdAt: string;
  status: 'active' | 'abandoned';
  baseMessageCount: number;
}

export interface InterviewMessagePart {
  type?: string;
  text?: string;
}

export interface InterviewMessage {
  info?: {
    role?: string;
    [key: string]: unknown;
  };
  parts?: InterviewMessagePart[];
}

export interface InterviewListItem {
  id: string;
  idea: string;
  status: InterviewRecord['status'];
  createdAt: string;
}

export interface InterviewFileItem {
  fileName: string;
  resumeCommand: string;
  title: string;
  summary: string;
  sessionID?: string;
  directory?: string;
}

export interface InterviewState {
  interview: InterviewRecord;
  url: string;
  markdownPath: string;
  mode:
    | 'awaiting-agent'
    | 'awaiting-user'
    | 'abandoned'
    | 'completed'
    | 'error'
    | 'session-disconnected';
  lastParseError?: string;
  isBusy: boolean;
  summary: string;
  questions: InterviewQuestion[];
  document: string;
}

/** Wire format for dashboard state cache entries. */
export interface InterviewStateEntry {
  interviewId: string;
  sessionID: string;
  idea: string;
  mode:
    | 'awaiting-agent'
    | 'awaiting-user'
    | 'abandoned'
    | 'completed'
    | 'error'
    | 'session-disconnected';
  summary: string;
  title: string;
  questions: Array<{
    id: string;
    question: string;
    options?: string[];
    suggested?: string;
  }>;
  pendingAnswers: Array<{
    questionId: string;
    answer: string;
  }> | null;
  lastUpdatedAt: number;
  filePath: string;
  nudgeAction: 'more-questions' | 'confirm-complete' | null;
}
