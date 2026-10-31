export type SmartfetchOptions = {
  binaryDir?: string;
};

type RedirectStep = {
  from: string;
  to: string;
  status: number;
};

export type CachedFetch = {
  finalUrl: string;
  statusCode: number;
  contentType: string;
  charset?: string;
  etag?: string;
  lastModified?: string;
  contentLength?: number;
  filename?: string;
  canonicalUrl?: string;
  headings?: string[];
  title?: string;
  rawContent: string;
  markdown: string;
  text: string;
  html: string;
  extractedMain: boolean;
  usedLlmsTxt: boolean;
  sourceKind: 'llms_txt' | 'html' | 'text';
  upgradedToHttps: boolean;
  redirectChain: RedirectStep[];
  truncated: boolean;
  wordCount: number;
  qualitySignals?: string[];
  llmsProbeError?: string;
  decodedCharset?: string;
  decodeFallback?: boolean;
  decodeWarning?: string;
};

export type BinaryFetch = {
  finalUrl: string;
  statusCode: number;
  contentType: string;
  charset?: string;
  etag?: string;
  lastModified?: string;
  contentLength?: number;
  filename?: string;
  canonicalUrl?: string;
  redirectChain: RedirectStep[];
  upgradedToHttps: boolean;
  truncated: boolean;
  binary: true;
  binaryKind: 'image' | 'audio' | 'video' | 'pdf' | 'binary';
  downloadLimitBytes?: number;
  data?: Uint8Array;
  llmsProbeError?: string;
};

export type FetchResult = CachedFetch | BinaryFetch;

export type DecodedBody = {
  text: string;
  decodedCharset: string;
  decodeFallback: boolean;
  decodeWarning?: string;
};

export type ExtractedContent = {
  title?: string;
  rawContent: string;
  markdown: string;
  text: string;
  html: string;
  extractedMain: boolean;
  canonicalUrl?: string;
  headings?: string[];
};

export type FetchWithRedirectsResult =
  | {
      blockedRedirect: true;
      redirectUrl: string;
      statusCode: number;
      redirectChain: RedirectStep[];
    }
  | {
      response: Response;
      finalUrl: string;
      redirectChain: RedirectStep[];
    };

export type LlmsProbeResult =
  | {
      url: string;
      statusCode: number;
      redirectChain: RedirectStep[];
      text: string;
      headers: {
        contentType?: string;
        charset?: string;
        etag?: string;
        lastModified?: string;
        contentLength?: number;
        filename?: string;
      };
      truncated: boolean;
      decodedCharset: string;
      decodeFallback: boolean;
      decodeWarning?: string;
      upgradedToHttps: boolean;
    }
  | {
      error?: string;
    };
