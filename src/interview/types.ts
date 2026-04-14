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

export interface InterviewState {
  interview: InterviewRecord;
  url: string;
  markdownPath: string;
  mode: 'awaiting-agent' | 'awaiting-user' | 'abandoned' | 'error';
  lastParseError?: string;
  isBusy: boolean;
  summary: string;
  questions: InterviewQuestion[];
  document: string;
}
