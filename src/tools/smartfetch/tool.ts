import os from 'node:os';
import path from 'node:path';
import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { buildBinaryResultMessage, saveBinary } from './binary';
import { buildCacheKey, CACHE } from './cache';
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_BINARY_DOWNLOAD_BYTES,
  MAX_LLMS_PROBE_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MAX_TIMEOUT_SECONDS,
  WEBFETCH_DESCRIPTION,
} from './constants';
import {
  ACCEPT_BY_FORMAT,
  buildPermissionPatterns,
  decodeBody,
  discard,
  extractHeaderMetadata,
  fetchWithUpgradeFallback,
  getBinaryKind,
  isBinaryContentType,
  isDocsLikeUrl,
  isGenericBinaryMime,
  isHtmlLikeContentType,
  looksLikeHtmlText,
  looksLikeTextBody,
  normalizeUrl,
  probeLlmsText,
  readBodyLimited,
  runWithScopedTimeout,
} from './network';
import {
  decideSecondaryModelUse,
  resolveSecondaryModels,
  runSecondaryModelWithFallback,
} from './secondary-model';
import type { CachedFetch, RedirectStep, SmartfetchOptions } from './types';
import {
  buildLlmsRequiredMessage,
  buildRedirectResultMessage,
  cleanFetchedMarkdown,
  cleanFetchedText,
  detectQualitySignals,
  extractFromHtml,
  extractHeadingsFromMarkdown,
  frontmatter,
  inferCanonicalUrlFromText,
  joinRenderedContent,
  renderMessageForFormat,
  trimBlankRuns,
  wordCount,
} from './utils';

const z = tool.schema;
const ARGS = {
  url: z.httpUrl(),
  format: z.enum(['text', 'markdown', 'html']).default('markdown'),
  timeout: z
    .number()
    .positive()
    .max(MAX_TIMEOUT_SECONDS)
    .optional()
    .describe('Timeout in seconds, max 120.'),
  prompt: z
    .string()
    .optional()
    .describe(
      'Optional extraction task to run on the fetched content using a cheap secondary model.',
    ),
  extract_main: z.boolean().default(true),
  prefer_llms_txt: z.enum(['auto', 'always', 'never']).default('auto'),
  include_metadata: z.boolean().default(true),
  save_binary: z
    .boolean()
    .default(false)
    .describe(
      'Save binary payload to disk when it fits within the active download limit.',
    ),
};

function pickContent(
  fetchResult: CachedFetch,
  format: 'text' | 'markdown' | 'html',
) {
  const content =
    format === 'html'
      ? fetchResult.sourceKind === 'html'
        ? fetchResult.extractedMain
          ? fetchResult.html
          : fetchResult.rawContent
        : renderMessageForFormat(
            fetchResult.text || fetchResult.rawContent,
            format,
          )
      : format === 'text'
        ? cleanFetchedText(fetchResult.text)
        : cleanFetchedMarkdown(fetchResult.markdown);
  if (!fetchResult.truncated) return content;
  return format === 'html'
    ? `${content}\n<!-- [..content truncated..] -->`
    : `${content}\n\n[..content truncated..]`;
}

export function createWebfetchTool(
  pluginCtx: PluginInput,
  options: SmartfetchOptions = {},
): ToolDefinition {
  const binaryDir =
    options.binaryDir || path.join(os.tmpdir(), 'opencode-smartfetch');

  return tool({
    description: WEBFETCH_DESCRIPTION,
    args: ARGS,
    async execute(rawArgs, ctx) {
      const args = z.object(ARGS).parse(rawArgs);
      const secondaryModels = resolveSecondaryModels({
        webfetchModels: options.webfetchModels,
        smallModel: options.smallModelRef?.() ?? undefined,
        explorerModel: options.explorerModel,
        librarianModel: options.librarianModel,
      });
      const normalized = normalizeUrl(args.url);
      const url = new URL(normalized.url);
      const cacheOptions = {
        format: args.format,
        extract_main: args.extract_main,
        prefer_llms_txt: args.prefer_llms_txt,
        save_binary: args.save_binary,
      };
      const cacheKey = buildCacheKey(args.url, cacheOptions);
      const shouldProbeLlmsTxt =
        args.prefer_llms_txt === 'always' ||
        (args.prefer_llms_txt === 'auto' && isDocsLikeUrl(url));
      const permissionPatterns = buildPermissionPatterns(
        normalized,
        shouldProbeLlmsTxt,
      );

      await ctx.ask({
        permission: 'webfetch',
        patterns: permissionPatterns,
        always: permissionPatterns,
        metadata: {
          url: normalized.url,
          requested_url: args.url,
          fallback_url: normalized.fallbackUrl,
          llms_probe_enabled: shouldProbeLlmsTxt,
          format: args.format,
          prompt: args.prompt,
        },
      });

      const timeoutMs = Math.min(
        (args.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
        MAX_TIMEOUT_SECONDS * 1000,
      );
      return runWithScopedTimeout(ctx.abort, timeoutMs, async (signal) => {
        signal.throwIfAborted();
        let fetchResult = CACHE.get(cacheKey);
        const cacheHit = !!fetchResult;
        if (!fetchResult) {
          let llmsProbeError: string | undefined;

          if (shouldProbeLlmsTxt) {
            const fallbackOrigin = normalized.fallbackUrl
              ? new URL(normalized.fallbackUrl).origin
              : undefined;
            const probeTimeoutMs = Math.max(
              1,
              Math.min(MAX_LLMS_PROBE_TIMEOUT_MS, timeoutMs),
            );
            const llms = await runWithScopedTimeout(
              signal,
              probeTimeoutMs,
              (probeSignal) => probeLlmsText(url, probeSignal, fallbackOrigin),
            );
            if (llms && 'text' in llms) {
              const llmsHeaders = llms.headers || {};
              const text = trimBlankRuns(llms.text);
              fetchResult = {
                finalUrl: llms.url,
                statusCode: llms.statusCode,
                contentType: llmsHeaders.contentType || 'text/plain',
                charset: llmsHeaders.charset,
                etag: llmsHeaders.etag,
                lastModified: llmsHeaders.lastModified,
                contentLength: llmsHeaders.contentLength,
                filename: llmsHeaders.filename,
                canonicalUrl: inferCanonicalUrlFromText(text, llms.url),
                headings: extractHeadingsFromMarkdown(text),
                title: undefined,
                rawContent: text,
                markdown: text,
                text,
                html: text,
                extractedMain: false,
                usedLlmsTxt: true,
                sourceKind: 'llms_txt',
                upgradedToHttps: !!llms.upgradedToHttps,
                redirectChain: llms.redirectChain || [],
                truncated: !!llms.truncated,
                wordCount: wordCount(text),
                qualitySignals: detectQualitySignals({
                  text,
                  markdown: text,
                  rawContent: text,
                  wordCount: wordCount(text),
                  sourceKind: 'llms_txt',
                  extractedMain: false,
                }),
                decodedCharset: llms.decodedCharset,
                decodeFallback: llms.decodeFallback,
                decodeWarning: llms.decodeWarning,
              };
            } else if (llms?.error) {
              llmsProbeError = llms.error;
            }

            if (!fetchResult && args.prefer_llms_txt === 'always') {
              const metadata = args.include_metadata
                ? frontmatter({
                    requested_url: args.url,
                    used_llms_txt: false,
                    llms_probe_error: llmsProbeError,
                    prefer_llms_txt: args.prefer_llms_txt,
                  })
                : '';
              return joinRenderedContent(
                metadata,
                renderMessageForFormat(
                  buildLlmsRequiredMessage(args.url, llmsProbeError),
                  args.format,
                ),
                args.format,
              );
            }
          }

          if (!fetchResult) {
            const { result, upgradedToHttps } = await fetchWithUpgradeFallback(
              normalized,
              signal,
              { Accept: ACCEPT_BY_FORMAT[args.format] },
            );
            if ('blockedRedirect' in result) {
              const metadata = args.include_metadata
                ? frontmatter({
                    requested_url: args.url,
                    redirect_url: result.redirectUrl,
                    status_code: result.statusCode,
                    redirect_chain: result.redirectChain.map(
                      (step: RedirectStep) =>
                        `${step.status} ${step.from} -> ${step.to}`,
                    ),
                    upgraded_to_https: upgradedToHttps,
                  })
                : '';
              return joinRenderedContent(
                metadata,
                renderMessageForFormat(
                  buildRedirectResultMessage(
                    args.url,
                    result.redirectUrl,
                    result.statusCode,
                  ),
                  args.format,
                ),
                args.format,
              );
            }

            const { response, finalUrl, redirectChain } = result;
            if (!response.ok) {
              await discard(response);
              throw new Error(
                `Request failed with status code: ${response.status}`,
              );
            }
            const headerMetadata = extractHeaderMetadata(
              response.headers,
              finalUrl,
            );
            const declaredType = headerMetadata.contentType || '';
            const explicitBinary = isBinaryContentType(declaredType);
            const genericBinaryMime = isGenericBinaryMime(declaredType);
            const binaryDownloadLimit = args.save_binary
              ? MAX_RESPONSE_BYTES
              : MAX_BINARY_DOWNLOAD_BYTES;
            const oversizedBinary =
              explicitBinary &&
              !genericBinaryMime &&
              typeof headerMetadata.contentLength === 'number' &&
              headerMetadata.contentLength > binaryDownloadLimit;
            let body = { data: new Uint8Array(), truncated: false };
            if (oversizedBinary) {
              await discard(response);
            } else {
              const readLimit =
                explicitBinary && !genericBinaryMime
                  ? binaryDownloadLimit
                  : MAX_RESPONSE_BYTES;
              body = await readBodyLimited(response, readLimit);
            }
            const baseFetch = {
              finalUrl,
              statusCode: response.status,
              ...headerMetadata,
              redirectChain,
              upgradedToHttps,
              truncated: body.truncated,
              llmsProbeError,
            };
            const provisionalDecoded =
              !oversizedBinary &&
              (!declaredType ||
                genericBinaryMime ||
                /^text\//i.test(declaredType))
                ? decodeBody(body.data, headerMetadata.charset, declaredType)
                : undefined;
            const looksHtmlPayload = provisionalDecoded
              ? looksLikeHtmlText(provisionalDecoded.text)
              : false;
            let contentType = declaredType;
            if (!contentType) {
              contentType = looksLikeTextBody(body.data)
                ? looksHtmlPayload
                  ? 'text/html'
                  : 'text/plain'
                : 'application/octet-stream';
            } else if (
              (genericBinaryMime && looksLikeTextBody(body.data)) ||
              (/^text\/plain(?:;|$)/i.test(contentType) && looksHtmlPayload)
            ) {
              contentType = looksHtmlPayload ? 'text/html' : 'text/plain';
            }
            if (isBinaryContentType(contentType)) {
              const binaryTooLarge =
                oversizedBinary ||
                body.truncated ||
                (typeof headerMetadata.contentLength === 'number' &&
                  headerMetadata.contentLength > binaryDownloadLimit);
              fetchResult = {
                ...baseFetch,
                contentType,
                canonicalUrl: finalUrl,
                binary: true,
                binaryKind: getBinaryKind(contentType),
                downloadLimitBytes: binaryDownloadLimit,
                data: binaryTooLarge ? undefined : body.data,
              };
            } else {
              const decoded =
                provisionalDecoded ||
                decodeBody(body.data, headerMetadata.charset, contentType);
              const rawText = decoded.text;
              const isHtml = isHtmlLikeContentType(contentType);
              const extracted = isHtml
                ? await extractFromHtml(rawText, finalUrl, args.extract_main)
                : (() => {
                    const cleaned = cleanFetchedText(rawText);
                    return {
                      title: undefined,
                      rawContent: cleaned,
                      html: cleaned,
                      text: cleaned,
                      markdown: cleaned,
                      extractedMain: false,
                      canonicalUrl: undefined,
                      headings: [],
                    };
                  })();
              const count = wordCount(extracted.text);
              const sourceKind = isHtml ? 'html' : 'text';
              fetchResult = {
                ...baseFetch,
                contentType,
                canonicalUrl:
                  extracted.canonicalUrl ||
                  inferCanonicalUrlFromText(extracted.markdown, finalUrl) ||
                  finalUrl,
                headings: extracted.headings?.length
                  ? extracted.headings
                  : extractHeadingsFromMarkdown(extracted.markdown),
                title: extracted.title,
                rawContent: extracted.rawContent,
                markdown: extracted.markdown,
                text: extracted.text,
                html: extracted.html,
                extractedMain: extracted.extractedMain,
                usedLlmsTxt: false,
                sourceKind,
                wordCount: count,
                qualitySignals: detectQualitySignals({
                  text: extracted.text,
                  markdown: extracted.markdown,
                  rawContent: extracted.rawContent,
                  wordCount: count,
                  sourceKind,
                  extractedMain: extracted.extractedMain,
                }),
                decodedCharset: decoded.decodedCharset,
                decodeFallback: decoded.decodeFallback,
                decodeWarning: decoded.decodeWarning,
              };
            }
          }
        }
        if (!cacheHit) CACHE.set(cacheKey, fetchResult);

        ctx.metadata({
          title:
            ('binary' in fetchResult
              ? fetchResult.filename
              : fetchResult.title) || fetchResult.finalUrl,
          metadata: {
            url: fetchResult.finalUrl,
            contentType: fetchResult.contentType,
            truncated: fetchResult.truncated,
          },
        });

        const baseMeta = {
          requested_url: args.url,
          final_url: fetchResult.finalUrl,
          canonical_url: fetchResult.canonicalUrl,
          status_code: fetchResult.statusCode,
          source_content_type: fetchResult.contentType,
          charset: fetchResult.charset,
          etag: fetchResult.etag,
          last_modified: fetchResult.lastModified,
          content_length: fetchResult.contentLength,
          filename: fetchResult.filename,
        };
        const chain = fetchResult.redirectChain.map(
          (step: RedirectStep) => `${step.status} ${step.from} -> ${step.to}`,
        );
        const render = (meta: Record<string, unknown>, body: string) =>
          joinRenderedContent(
            args.include_metadata ? frontmatter(meta) : '',
            body,
            args.format,
          );

        if ('binary' in fetchResult) {
          const binaryMeta = {
            ...baseMeta,
            binary_kind: fetchResult.binaryKind,
            redirect_chain: chain,
            upgraded_to_https: fetchResult.upgradedToHttps,
            llms_probe_error: fetchResult.llmsProbeError,
            cache_hit: cacheHit,
            truncated: fetchResult.truncated,
            download_limit_bytes:
              fetchResult.downloadLimitBytes ?? MAX_BINARY_DOWNLOAD_BYTES,
          };
          if (!fetchResult.data) {
            return render(
              { ...binaryMeta, binary_metadata_only: true },
              renderMessageForFormat(
                buildBinaryResultMessage(fetchResult),
                args.format,
              ),
            );
          }
          if (!args.save_binary) {
            return render(
              { ...binaryMeta, save_binary: false },
              renderMessageForFormat(
                `${fetchResult.binaryKind.toUpperCase()} content fetched but not saved. Re-run with save_binary=true to persist it.`,
                args.format,
              ),
            );
          }
          const savedPath = await saveBinary(
            binaryDir,
            fetchResult.data,
            fetchResult.contentType,
            fetchResult.filename,
          );
          return render(
            { ...binaryMeta, saved_path: savedPath },
            renderMessageForFormat(
              buildBinaryResultMessage(fetchResult, savedPath),
              args.format,
            ),
          );
        }

        const baseContent = pickContent(fetchResult, args.format);
        const secondaryModelDecision = decideSecondaryModelUse(
          fetchResult,
          args.prompt,
          secondaryModels,
        );
        const textMeta = {
          ...baseMeta,
          headings: fetchResult.headings,
          title: fetchResult.title,
          source_kind: fetchResult.sourceKind,
          used_llms_txt: fetchResult.usedLlmsTxt,
          extracted_main: fetchResult.extractedMain,
          redirect_chain: chain,
          upgraded_to_https: fetchResult.upgradedToHttps,
          llms_probe_error: fetchResult.llmsProbeError,
          llms_probe_truncated:
            fetchResult.usedLlmsTxt && fetchResult.truncated,
          cache_hit: cacheHit,
          truncated: fetchResult.truncated,
          word_count: fetchResult.wordCount,
          quality_signals: fetchResult.qualitySignals,
          decoded_charset: fetchResult.decodedCharset,
          decode_fallback: fetchResult.decodeFallback,
          decode_warning: fetchResult.decodeWarning,
        };

        if (!secondaryModelDecision.use) {
          return render(
            {
              ...textMeta,
              secondary_model_skipped_reason: args.prompt
                ? secondaryModelDecision.reason
                : undefined,
            },
            baseContent,
          );
        }

        let secondaryRun:
          | Awaited<ReturnType<typeof runSecondaryModelWithFallback>>
          | undefined;
        let secondaryModelError: string | undefined;
        try {
          secondaryRun = await runSecondaryModelWithFallback(
            pluginCtx,
            secondaryModels,
            args.prompt || '',
            fetchResult.markdown,
            ctx.sessionID,
          );
        } catch (error: unknown) {
          secondaryModelError =
            error instanceof Error ? error.message : String(error);
        }

        if (!secondaryRun) {
          return render(
            {
              ...textMeta,
              secondary_model_skipped_reason: 'secondary_model_failed',
              secondary_model_error: secondaryModelError,
            },
            baseContent,
          );
        }

        return render(
          {
            ...textMeta,
            secondary_model_input_truncated: secondaryRun.inputTruncated,
            secondary_model_input_chars: secondaryRun.inputChars,
            secondary_model_source_chars: secondaryRun.sourceChars,
            secondary_model: `${secondaryRun.model.providerID}/${secondaryRun.model.modelID}${secondaryRun.model.variant ? `#${secondaryRun.model.variant}` : ''}`,
          },
          renderMessageForFormat(secondaryRun.text, args.format),
        );
      });
    },
  });
}
