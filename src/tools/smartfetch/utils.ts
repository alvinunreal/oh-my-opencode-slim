import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import type { CachedFetch, ExtractedContent } from './types';

export function wordCount(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function byteLength(text: string) {
  return Buffer.byteLength(text || '', 'utf8');
}

function quote(value: unknown) {
  return JSON.stringify(value ?? '');
}

export function frontmatter(metadata: Record<string, unknown>) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${quote(item)}`);
      continue;
    }
    lines.push(`${key}: ${quote(value)}`);
  }
  lines.push('---', '', '');
  return lines.join('\n');
}

export function trimBlankRuns(input: string) {
  return input.replace(/\n{3,}/g, '\n\n').trim();
}

function cleanExtractedText(input: string) {
  return trimBlankRuns(input);
}

function mapOutsideCodeBlocks(
  input: string,
  transform: (value: string) => string,
) {
  const parts = input.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  return parts
    .map((part, index) => (index % 2 === 1 ? part : transform(part)))
    .join('');
}

function extractStructuredText(root: Element | null) {
  if (!root) return '';
  const chunks: string[] = [];
  const ignoredTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const blockTags = new Set([
    'ARTICLE',
    'ASIDE',
    'BLOCKQUOTE',
    'DIV',
    'DL',
    'DT',
    'DD',
    'FIGCAPTION',
    'FIGURE',
    'FOOTER',
    'FORM',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HEADER',
    'HR',
    'LI',
    'MAIN',
    'NAV',
    'OL',
    'P',
    'PRE',
    'SECTION',
    'TABLE',
    'TBODY',
    'TD',
    'TH',
    'THEAD',
    'TR',
    'UL',
  ]);
  const isText = (node: Node) => node.nodeType === node.TEXT_NODE;
  const isElement = (node: Node) => node.nodeType === node.ELEMENT_NODE;
  const pushText = (value: string) => {
    const normalized = value.replace(/\s+/g, ' ');
    if (!normalized.trim()) return;
    const previous = chunks[chunks.length - 1];
    if (!previous || /\n$| $/.test(previous)) {
      chunks.push(normalized.trimStart());
    } else {
      chunks.push(normalized);
    }
  };
  const pushBreak = (count = 1) => {
    const wanted = '\n'.repeat(count);
    const last = chunks[chunks.length - 1] || '';
    const trailing = last.match(/\n+$/)?.[0].length || 0;
    if (trailing >= count) return;
    if (trailing > 0) {
      chunks[chunks.length - 1] = last.replace(/\n+$/, '') + wanted;
      return;
    }
    chunks.push(wanted);
  };
  const visit = (node: Node) => {
    if (isText(node)) {
      pushText(node.textContent || '');
      return;
    }
    if (!isElement(node)) return;
    const element = node as Element;
    const tag = element.tagName;
    if (ignoredTags.has(tag)) return;
    if (tag === 'BR') {
      pushBreak(1);
      return;
    }
    if (tag === 'PRE') {
      const text = trimBlankRuns(element.textContent || '');
      if (!text) return;
      pushBreak(2);
      chunks.push(text);
      pushBreak(2);
      return;
    }
    const isBlock = blockTags.has(tag);
    if (isBlock) pushBreak(tag === 'LI' ? 1 : 2);
    if (tag === 'LI') chunks.push('- ');
    for (const child of element.childNodes) visit(child);
    if (isBlock) pushBreak(tag === 'LI' ? 1 : 2);
  };
  visit(root);
  return cleanExtractedText(chunks.join(''));
}

export function cleanHeadingText(input: string) {
  const normalized = trimBlankRuns(input).replace(/¶+$/g, '').trim();
  if (/^(?:C|F)#$/.test(normalized)) return normalized;
  if (/\s#+$/.test(normalized)) {
    return normalized.replace(/\s#+$/g, '').trim();
  }
  return normalized;
}

export function cleanFetchedMarkdown(input: string) {
  const output = mapOutsideCodeBlocks(input, (value) =>
    value
      .replace(/^\s*!\[[^\]]*\]\([^)]+\)\s*$/gm, 'Image omitted')
      .replace(/(^|\n)Image(?=\n|$)/g, '$1Image omitted')
      .replace(/^\s*(#{1,6})\s*\\?\['([^'\n]+)'\s*$/gm, '$1 $2')
      .replace(/^\s*(#{1,6})\s*'([^'\n]+)'\]\s*$/gm, '$1 $2')
      .replace(/^\s*(#{1,6})\s*'([^'\n]+)'\s*$/gm, '$1 $2')
      .replace(/(#{1,6}[^\n]*?)\s*\[¶\]\(#.*?"Permanent link"\)\s*$/gm, '$1')
      .replace(/\s+\(#[A-Za-z0-9_-]+\)\s*$/gm, ''),
  );

  return trimBlankRuns(output);
}

export function cleanFetchedText(input: string) {
  return trimBlankRuns(input);
}

export function escapeHtml(input: string) {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function withTruncationMarker(
  content: string,
  format: 'text' | 'markdown' | 'html',
  truncated: boolean,
) {
  if (!truncated) return content;
  if (format === 'html') return `${content}\n<!-- [..content truncated..] -->`;
  return `${content}\n\n[..content truncated..]`;
}

export function joinRenderedContent(
  metadata: string,
  content: string,
  format: 'text' | 'markdown' | 'html',
) {
  if (!metadata) return content;
  if (!content) {
    return format === 'html' ? `<!--\n${metadata.trim()}\n-->` : metadata;
  }
  if (format === 'html') {
    const comment = `<!--\n${metadata.trim()}\n-->\n`;
    const xmlDecl = content.match(/^\s*(<\?xml[\s\S]*?\?>\s*)/i);
    if (xmlDecl) {
      return `${xmlDecl[1]}${comment}${content.slice(xmlDecl[0].length)}`;
    }
    return `${comment}${content}`;
  }
  const startsWithFrontmatter = /^---(?:\r?\n|$)/.test(content);
  if (!startsWithFrontmatter) return `${metadata}${content}`;
  return `${metadata}Source content:\n\n${content}`;
}

export function renderMessageForFormat(
  content: string,
  format: 'text' | 'markdown' | 'html',
) {
  if (format === 'html') return `<pre>${escapeHtml(content)}</pre>`;
  return content;
}

export function buildRedirectResultMessage(
  originalUrl: string,
  redirectUrl: string,
  statusCode: number,
) {
  return [
    'Redirect was blocked by policy.',
    `Original URL: ${originalUrl}`,
    `Redirect URL: ${redirectUrl}`,
    `Status: ${statusCode}`,
    '',
    'Re-run webfetch with the redirect URL to continue.',
  ].join('\n');
}

export function buildLlmsRequiredMessage(originalUrl: string, reason?: string) {
  return [
    'Required llms.txt content was unavailable.',
    `Original URL: ${originalUrl}`,
    ...(reason ? [`Reason: ${reason}`] : []),
  ].join('\n');
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
});

turndown.remove(['script', 'style', 'noscript', 'meta', 'link']);
turndown.remove(
  (node) =>
    node.nodeName === 'A' &&
    /permanent link/i.test((node as Element).getAttribute('title') || ''),
);
turndown.addRule('fenced-pre-code', {
  filter(node) {
    return node.nodeName === 'PRE' && !!(node as Element).querySelector('code');
  },
  replacement(_content, node) {
    const code = (node as Element).querySelector('code');
    const text = trimBlankRuns(code?.textContent || node.textContent || '');
    if (!text) return '';
    return `\n\n\`\`\`\n${text}\n\`\`\`\n\n`;
  },
});

export function extractFromHtml(
  html: string,
  finalUrl: string,
  extractMain: boolean,
): ExtractedContent {
  const dom = new JSDOM(html, { url: finalUrl });
  const document = dom.window.document;
  const title = document.title || undefined;
  const canonical =
    document.querySelector('link[rel="canonical"]')?.getAttribute('href') ||
    undefined;
  const canonicalUrl = (() => {
    if (!canonical) return undefined;
    try {
      return new URL(canonical, finalUrl).toString();
    } catch {
      return undefined;
    }
  })();
  const headings = Array.from(
    document.querySelectorAll<HTMLElement>('h1, h2, h3'),
  )
    .map((node) => cleanHeadingText(node.textContent || ''))
    .filter(Boolean)
    .slice(0, 12);

  if (extractMain) {
    const readerDom = new JSDOM(html, { url: finalUrl });
    const article = new Readability(readerDom.window.document).parse();
    if (article?.content?.trim()) {
      const articleContainer = readerDom.window.document.createElement('div');
      articleContainer.innerHTML = article.content;
      const articleText = extractStructuredText(articleContainer);
      const articleMarkdown = trimBlankRuns(turndown.turndown(article.content));
      return {
        title: article.title || title,
        rawContent: html,
        html: article.content,
        text: articleText,
        markdown: articleMarkdown,
        extractedMain: true,
        canonicalUrl,
        headings,
      };
    }
  }

  const bodyHtml = document.body?.innerHTML || html;
  const bodyText = extractStructuredText(document.body);
  const markdown = trimBlankRuns(turndown.turndown(bodyHtml));
  return {
    title,
    rawContent: html,
    html: bodyHtml,
    text: bodyText,
    markdown,
    extractedMain: false,
    canonicalUrl,
    headings,
  };
}

function parseFrontmatterBlock(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return undefined;
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.+?)\s*$/);
    if (!kv) continue;
    result[kv[1]] = kv[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return result;
}

export function inferCanonicalUrlFromText(content: string, finalUrl: string) {
  const frontmatter = parseFrontmatterBlock(content);
  const raw = frontmatter?.url;
  if (!raw) return undefined;
  try {
    return new URL(raw, finalUrl).toString();
  } catch {
    return undefined;
  }
}

export function extractHeadingsFromMarkdown(content: string) {
  const headings = content
    .split(/\r?\n/)
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => cleanHeadingText(line.replace(/^#{1,6}\s+/, '')))
    .filter(Boolean)
    .slice(0, 12);
  return headings.length ? headings : undefined;
}

export function detectQualitySignals(
  fetchResult: Pick<
    CachedFetch,
    | 'text'
    | 'markdown'
    | 'rawContent'
    | 'wordCount'
    | 'sourceKind'
    | 'extractedMain'
  >,
) {
  const signals = new Set<string>();
  const text = `${fetchResult.text}\n${fetchResult.markdown}`.toLowerCase();

  if (fetchResult.wordCount > 0 && fetchResult.wordCount < 60) {
    signals.add('very_short_content');
  }

  if (
    /(subscribe to continue|subscription required|sign in to continue|log in to continue|create an account to continue|members only|premium content|paywall)/i.test(
      text,
    )
  ) {
    signals.add('possible_paywall');
  }

  if (fetchResult.sourceKind === 'html') {
    const renderedBytes = Math.max(byteLength(fetchResult.text), 1);
    const rawBytes = byteLength(fetchResult.rawContent);
    const ratio = rawBytes / renderedBytes;
    if (
      !fetchResult.extractedMain &&
      ratio >= 10 &&
      fetchResult.wordCount < 1200
    ) {
      signals.add('high_boilerplate_ratio');
    }
  }

  return [...signals];
}

export function pickContent(
  fetchResult: CachedFetch,
  format: 'text' | 'markdown' | 'html',
) {
  if (format === 'html') {
    if (fetchResult.sourceKind === 'html') {
      const htmlContent = fetchResult.extractedMain
        ? fetchResult.html
        : fetchResult.rawContent;
      return withTruncationMarker(htmlContent, format, fetchResult.truncated);
    }
    return withTruncationMarker(
      renderMessageForFormat(
        fetchResult.text || fetchResult.rawContent,
        format,
      ),
      format,
      fetchResult.truncated,
    );
  }
  if (format === 'text') {
    return withTruncationMarker(
      cleanFetchedText(fetchResult.text),
      format,
      fetchResult.truncated,
    );
  }
  return withTruncationMarker(
    cleanFetchedMarkdown(fetchResult.markdown),
    format,
    fetchResult.truncated,
  );
}
