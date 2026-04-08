import os from 'node:os';
import path from 'node:path';
import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { buildBinaryResultMessage, saveBinary } from './binary';
import {
  buildCacheKey,
  CACHE,
  cacheFetchResult,
  isInvalidLlmsResult,
} from './cache';
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_BINARY_DOWNLOAD_BYTES,
  MAX_LLMS_PROBE_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MAX_TIMEOUT_SECONDS,
  WEBFETCH_DESCRIPTION,
} from './constants';
import {
  buildAllowedOrigins,
  buildConditionalHeaders,
  buildPermissionPatterns,
  decodeBody,
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
  readSecondaryModelFromConfig,
  runSecondaryModelWithFallback,
} from './secondary-model';
import type { SmartfetchOptions } from './types';
import {
  buildLlmsRequiredMessage,
  buildRedirectResultMessage,
  cleanFetchedText,
  detectQualitySignals,
  escapeHtml,
  extractFromHtml,
  extractHeadingsFromMarkdown,
  frontmatter,
  inferCanonicalUrlFromText,
  joinRenderedContent,
  pickContent,
  renderMessageForFormat,
  trimBlankRuns,
  withTruncationMarker,
  wordCount,
} from './utils';

const z = tool.schema;

export function createWebfetchTool(
  pluginCtx: PluginInput,
  options: SmartfetchOptions = {},
): ToolDefinition {
  const binaryDir =
    options.binaryDir || path.join(os.tmpdir(), 'opencode-smartfetch');

  return tool({
    description: WEBFETCH_DESCRIPTION,
    args: {
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
    },
    async execute(args, ctx) {
      const secondaryModels = await readSecondaryModelFromConfig(
        ctx.directory || pluginCtx.directory,
      );
      const normalized = normalizeUrl(args.url);
      const url = new URL(normalized.url);
      const cacheKey = buildCacheKey(
        args.url,
        args.extract_main,
        args.prefer_llms_txt,
        args.save_binary,
      );
      const shouldProbeLlmsTxt =
        args.prefer_llms_txt === 'always' ||
        (args.prefer_llms_txt === 'auto' && isDocsLikeUrl(url));
      const permissionPatterns = buildPermissionPatterns(
        normalized,
        shouldProbeLlmsTxt,
      );
      const allowedOrigins = buildAllowedOrigins(permissionPatterns);

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
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error(`timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
      const abortHandler = () => controller.abort(ctx.abort.reason);
      ctx.abort.addEventListener('abort', abortHandler, { once: true });

      try {
        let fetchResult = CACHE.get(cacheKey);
        if (isInvalidLlmsResult(fetchResult)) {
          CACHE.delete(cacheKey);
          fetchResult = undefined;
        }
        const cacheHit = !!fetchResult;
        if (fetchResult) {
          fetchResult = {
            ...fetchResult,
            requestedUrl: args.url,
            cacheHit: true,
          };
        }
        if (!fetchResult) {
          let staleFetchResult = CACHE.get(cacheKey, {
            allowStale: true,
            noDeleteOnStaleGet: true,
          });
          if (isInvalidLlmsResult(staleFetchResult)) {
            CACHE.delete(cacheKey);
            staleFetchResult = undefined;
          }
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
              controller.signal,
              probeTimeoutMs,
              (probeSignal) =>
                probeLlmsText(url, timeoutMs, probeSignal, fallbackOrigin),
            );
            if (llms && 'text' in llms) {
              const llmsHeaders = llms.headers || {};
              const text = trimBlankRuns(llms.text);
              fetchResult = {
                requestedUrl: args.url,
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
                llmsProbeTruncated: !!llms.truncated,
                decodedCharset: llms.decodedCharset,
                decodeFallback: llms.decodeFallback,
                decodeWarning: llms.decodeWarning,
                cacheHit: false,
              };
              cacheFetchResult(
                fetchResult,
                args.extract_main,
                args.prefer_llms_txt,
                args.save_binary,
              );
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
              timeoutMs,
              args.format,
              controller.signal,
              buildConditionalHeaders(staleFetchResult),
              'GET',
              allowedOrigins,
            );
            if ('blockedRedirect' in result) {
              const metadata = args.include_metadata
                ? frontmatter({
                    requested_url: args.url,
                    redirect_url: result.redirectUrl,
                    status_code: result.statusCode,
                    redirect_chain: result.redirectChain.map(
                      (step) => `${step.status} ${step.from} -> ${step.to}`,
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
            if (response.status === 304 && staleFetchResult) {
              fetchResult = {
                ...staleFetchResult,
                requestedUrl: args.url,
                finalUrl,
                statusCode: staleFetchResult.statusCode,
                redirectChain,
                llmsProbeError,
                cacheRevalidated: true,
                upstreamStatusCode: 304,
                cacheHit: false,
              };
              cacheFetchResult(
                fetchResult,
                args.extract_main,
                args.prefer_llms_txt,
                args.save_binary,
              );
            } else {
              if (!response.ok) {
                throw new Error(
                  `Request failed with status code: ${response.status}`,
                );
              }
              const headerMetadata = extractHeaderMetadata(
                response.headers,
                finalUrl,
              );
              const explicitBinary = isBinaryContentType(
                headerMetadata.contentType || '',
              );
              const genericBinaryMime = isGenericBinaryMime(
                headerMetadata.contentType || '',
              );
              const binaryDownloadLimit = args.save_binary
                ? MAX_RESPONSE_BYTES
                : MAX_BINARY_DOWNLOAD_BYTES;
              if (
                explicitBinary &&
                !genericBinaryMime &&
                typeof headerMetadata.contentLength === 'number' &&
                headerMetadata.contentLength > binaryDownloadLimit
              ) {
                try {
                  await response.body?.cancel();
                } catch {
                  // ignore cancel failures
                }
                fetchResult = {
                  requestedUrl: args.url,
                  finalUrl,
                  statusCode: response.status,
                  contentType:
                    headerMetadata.contentType || 'application/octet-stream',
                  charset: headerMetadata.charset,
                  etag: headerMetadata.etag,
                  lastModified: headerMetadata.lastModified,
                  contentLength: headerMetadata.contentLength,
                  filename: headerMetadata.filename,
                  canonicalUrl: finalUrl,
                  redirectChain,
                  upgradedToHttps,
                  truncated: false,
                  binary: true,
                  binaryKind: getBinaryKind(
                    headerMetadata.contentType || 'application/octet-stream',
                  ),
                  downloadLimitBytes: binaryDownloadLimit,
                  metadataOnly: true,
                  data: undefined,
                  llmsProbeError,
                  llmsProbeTruncated: false,
                  cacheHit: false,
                };
                cacheFetchResult(
                  fetchResult,
                  args.extract_main,
                  args.prefer_llms_txt,
                  args.save_binary,
                );
              } else {
                const readLimit =
                  explicitBinary && !genericBinaryMime
                    ? binaryDownloadLimit
                    : MAX_RESPONSE_BYTES;
                const body = await readBodyLimited(response, readLimit);
                const provisionalDecoded =
                  !headerMetadata.contentType ||
                  genericBinaryMime ||
                  /^text\//i.test(headerMetadata.contentType)
                    ? decodeBody(
                        body.data,
                        headerMetadata.charset,
                        headerMetadata.contentType,
                      )
                    : undefined;
                const looksHtmlPayload = provisionalDecoded
                  ? looksLikeHtmlText(provisionalDecoded.text)
                  : false;
                const contentType = headerMetadata.contentType
                  ? genericBinaryMime && looksLikeTextBody(body.data)
                    ? looksHtmlPayload
                      ? 'text/html'
                      : 'text/plain'
                    : /^text\/plain(?:;|$)/i.test(headerMetadata.contentType) &&
                        looksHtmlPayload
                      ? 'text/html'
                      : headerMetadata.contentType
                  : looksLikeTextBody(body.data)
                    ? looksHtmlPayload
                      ? 'text/html'
                      : 'text/plain'
                    : 'application/octet-stream';

                if (isBinaryContentType(contentType)) {
                  const binaryTooLarge =
                    body.truncated ||
                    (typeof headerMetadata.contentLength === 'number' &&
                      headerMetadata.contentLength > binaryDownloadLimit);
                  fetchResult = {
                    requestedUrl: args.url,
                    finalUrl,
                    statusCode: response.status,
                    contentType,
                    charset: headerMetadata.charset,
                    etag: headerMetadata.etag,
                    lastModified: headerMetadata.lastModified,
                    contentLength: headerMetadata.contentLength,
                    filename: headerMetadata.filename,
                    canonicalUrl: finalUrl,
                    redirectChain,
                    upgradedToHttps,
                    truncated: body.truncated,
                    binary: true,
                    binaryKind: getBinaryKind(contentType),
                    downloadLimitBytes: binaryDownloadLimit,
                    metadataOnly: binaryTooLarge,
                    data: binaryTooLarge ? undefined : body.data,
                    llmsProbeError,
                    llmsProbeTruncated: false,
                    cacheHit: false,
                  };
                  cacheFetchResult(
                    fetchResult,
                    args.extract_main,
                    args.prefer_llms_txt,
                    args.save_binary,
                  );
                } else {
                  const decoded =
                    provisionalDecoded ||
                    decodeBody(body.data, headerMetadata.charset, contentType);
                  const rawText = decoded.text;
                  const extracted = isHtmlLikeContentType(contentType)
                    ? extractFromHtml(rawText, finalUrl, args.extract_main)
                    : {
                        title: undefined,
                        rawContent: cleanFetchedText(rawText),
                        html: cleanFetchedText(rawText),
                        text: cleanFetchedText(rawText),
                        markdown: cleanFetchedText(rawText),
                        extractedMain: false,
                        canonicalUrl: undefined,
                        headings: [],
                      };

                  fetchResult = {
                    requestedUrl: args.url,
                    finalUrl,
                    statusCode: response.status,
                    contentType,
                    charset: headerMetadata.charset,
                    etag: headerMetadata.etag,
                    lastModified: headerMetadata.lastModified,
                    contentLength: headerMetadata.contentLength,
                    filename: headerMetadata.filename,
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
                    sourceKind: isHtmlLikeContentType(contentType)
                      ? 'html'
                      : 'text',
                    upgradedToHttps,
                    redirectChain,
                    truncated: body.truncated,
                    wordCount: wordCount(extracted.text),
                    qualitySignals: detectQualitySignals({
                      text: extracted.text,
                      markdown: extracted.markdown,
                      rawContent: extracted.rawContent,
                      wordCount: wordCount(extracted.text),
                      sourceKind: isHtmlLikeContentType(contentType)
                        ? 'html'
                        : 'text',
                      extractedMain: extracted.extractedMain,
                    }),
                    llmsProbeError,
                    llmsProbeTruncated: false,
                    decodedCharset: decoded.decodedCharset,
                    decodeFallback: decoded.decodeFallback,
                    decodeWarning: decoded.decodeWarning,
                    cacheHit: false,
                  };
                  cacheFetchResult(
                    fetchResult,
                    args.extract_main,
                    args.prefer_llms_txt,
                    args.save_binary,
                  );
                }
              }
            }
          }
        }

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

        if ('binary' in fetchResult) {
          if (fetchResult.metadataOnly || !fetchResult.data) {
            const metadata = args.include_metadata
              ? frontmatter({
                  requested_url: fetchResult.requestedUrl,
                  final_url: fetchResult.finalUrl,
                  canonical_url: fetchResult.canonicalUrl,
                  status_code: fetchResult.statusCode,
                  source_content_type: fetchResult.contentType,
                  charset: fetchResult.charset,
                  etag: fetchResult.etag,
                  last_modified: fetchResult.lastModified,
                  content_length: fetchResult.contentLength,
                  filename: fetchResult.filename,
                  binary_kind: fetchResult.binaryKind,
                  redirect_chain: fetchResult.redirectChain.map(
                    (step) => `${step.status} ${step.from} -> ${step.to}`,
                  ),
                  upgraded_to_https: fetchResult.upgradedToHttps,
                  llms_probe_error: fetchResult.llmsProbeError,
                  cache_revalidated: fetchResult.cacheRevalidated,
                  cache_hit: fetchResult.cacheHit ?? cacheHit,
                  upstream_status_code: fetchResult.upstreamStatusCode,
                  truncated: fetchResult.truncated,
                  download_limit_bytes:
                    fetchResult.downloadLimitBytes ?? MAX_BINARY_DOWNLOAD_BYTES,
                  binary_metadata_only: true,
                })
              : '';
            return joinRenderedContent(
              metadata,
              renderMessageForFormat(
                buildBinaryResultMessage(fetchResult),
                args.format,
              ),
              args.format,
            );
          }
          if (!args.save_binary) {
            const metadata = args.include_metadata
              ? frontmatter({
                  requested_url: fetchResult.requestedUrl,
                  final_url: fetchResult.finalUrl,
                  canonical_url: fetchResult.canonicalUrl,
                  status_code: fetchResult.statusCode,
                  source_content_type: fetchResult.contentType,
                  charset: fetchResult.charset,
                  etag: fetchResult.etag,
                  last_modified: fetchResult.lastModified,
                  content_length: fetchResult.contentLength,
                  filename: fetchResult.filename,
                  binary_kind: fetchResult.binaryKind,
                  redirect_chain: fetchResult.redirectChain.map(
                    (step) => `${step.status} ${step.from} -> ${step.to}`,
                  ),
                  upgraded_to_https: fetchResult.upgradedToHttps,
                  truncated: fetchResult.truncated,
                  save_binary: false,
                  cache_hit: fetchResult.cacheHit ?? cacheHit,
                })
              : '';
            return joinRenderedContent(
              metadata,
              renderMessageForFormat(
                `${fetchResult.binaryKind.toUpperCase()} content fetched but not saved. Re-run with save_binary=true to persist it.`,
                args.format,
              ),
              args.format,
            );
          }
          const savedPath = await saveBinary(
            binaryDir,
            fetchResult.data,
            fetchResult.contentType,
            fetchResult.filename,
          );
          const metadata = args.include_metadata
            ? frontmatter({
                requested_url: fetchResult.requestedUrl,
                final_url: fetchResult.finalUrl,
                canonical_url: fetchResult.canonicalUrl,
                status_code: fetchResult.statusCode,
                source_content_type: fetchResult.contentType,
                charset: fetchResult.charset,
                etag: fetchResult.etag,
                last_modified: fetchResult.lastModified,
                content_length: fetchResult.contentLength,
                filename: fetchResult.filename,
                binary_kind: fetchResult.binaryKind,
                redirect_chain: fetchResult.redirectChain.map(
                  (step) => `${step.status} ${step.from} -> ${step.to}`,
                ),
                upgraded_to_https: fetchResult.upgradedToHttps,
                llms_probe_error: fetchResult.llmsProbeError,
                cache_revalidated: fetchResult.cacheRevalidated,
                cache_hit: fetchResult.cacheHit ?? cacheHit,
                upstream_status_code: fetchResult.upstreamStatusCode,
                truncated: fetchResult.truncated,
                download_limit_bytes:
                  fetchResult.downloadLimitBytes ?? MAX_BINARY_DOWNLOAD_BYTES,
                saved_path: savedPath,
              })
            : '';
          return joinRenderedContent(
            metadata,
            renderMessageForFormat(
              buildBinaryResultMessage(fetchResult, savedPath),
              args.format,
            ),
            args.format,
          );
        }

        const baseContent = pickContent(fetchResult, args.format);
        const secondaryModelDecision = decideSecondaryModelUse(
          fetchResult,
          args.prompt,
          secondaryModels,
        );
        const metadata = args.include_metadata
          ? frontmatter({
              requested_url: fetchResult.requestedUrl,
              final_url: fetchResult.finalUrl,
              canonical_url: fetchResult.canonicalUrl,
              status_code: fetchResult.statusCode,
              source_content_type: fetchResult.contentType,
              charset: fetchResult.charset,
              etag: fetchResult.etag,
              last_modified: fetchResult.lastModified,
              content_length: fetchResult.contentLength,
              filename: fetchResult.filename,
              headings: fetchResult.headings,
              title: fetchResult.title,
              source_kind: fetchResult.sourceKind,
              used_llms_txt: fetchResult.usedLlmsTxt,
              extracted_main: fetchResult.extractedMain,
              redirect_chain: fetchResult.redirectChain.map(
                (step) => `${step.status} ${step.from} -> ${step.to}`,
              ),
              upgraded_to_https: fetchResult.upgradedToHttps,
              llms_probe_error: fetchResult.llmsProbeError,
              llms_probe_truncated: fetchResult.llmsProbeTruncated,
              cache_revalidated: fetchResult.cacheRevalidated,
              cache_hit: fetchResult.cacheHit ?? cacheHit,
              upstream_status_code: fetchResult.upstreamStatusCode,
              truncated: fetchResult.truncated,
              word_count: fetchResult.wordCount,
              quality_signals: fetchResult.qualitySignals,
              decoded_charset: fetchResult.decodedCharset,
              decode_fallback: fetchResult.decodeFallback,
              decode_warning: fetchResult.decodeWarning,
              secondary_model: undefined,
              secondary_model_skipped_reason:
                !secondaryModelDecision.use && args.prompt
                  ? secondaryModelDecision.reason
                  : undefined,
            })
          : '';

        if (!secondaryModelDecision.use) {
          return joinRenderedContent(metadata, baseContent, args.format);
        }

        if (!secondaryModels.length) {
          return joinRenderedContent(metadata, baseContent, args.format);
        }
        let secondaryRun:
          | Awaited<ReturnType<typeof runSecondaryModelWithFallback>>
          | undefined;
        let secondaryModelError: string | undefined;
        try {
          secondaryRun = await runSecondaryModelWithFallback(
            pluginCtx.client,
            ctx.directory || process.cwd(),
            secondaryModels,
            args.prompt || '',
            fetchResult.markdown,
          );
        } catch (error: unknown) {
          secondaryModelError =
            error instanceof Error ? error.message : String(error);
        }

        if (!secondaryRun) {
          const degradedMetadata = args.include_metadata
            ? frontmatter({
                requested_url: fetchResult.requestedUrl,
                final_url: fetchResult.finalUrl,
                canonical_url: fetchResult.canonicalUrl,
                status_code: fetchResult.statusCode,
                source_content_type: fetchResult.contentType,
                charset: fetchResult.charset,
                etag: fetchResult.etag,
                last_modified: fetchResult.lastModified,
                content_length: fetchResult.contentLength,
                filename: fetchResult.filename,
                headings: fetchResult.headings,
                title: fetchResult.title,
                source_kind: fetchResult.sourceKind,
                used_llms_txt: fetchResult.usedLlmsTxt,
                extracted_main: fetchResult.extractedMain,
                redirect_chain: fetchResult.redirectChain.map(
                  (step) => `${step.status} ${step.from} -> ${step.to}`,
                ),
                upgraded_to_https: fetchResult.upgradedToHttps,
                llms_probe_error: fetchResult.llmsProbeError,
                llms_probe_truncated: fetchResult.llmsProbeTruncated,
                cache_revalidated: fetchResult.cacheRevalidated,
                cache_hit: fetchResult.cacheHit ?? cacheHit,
                upstream_status_code: fetchResult.upstreamStatusCode,
                truncated: fetchResult.truncated,
                word_count: fetchResult.wordCount,
                quality_signals: fetchResult.qualitySignals,
                decoded_charset: fetchResult.decodedCharset,
                decode_fallback: fetchResult.decodeFallback,
                decode_warning: fetchResult.decodeWarning,
                secondary_model: undefined,
                secondary_model_skipped_reason: 'secondary_model_failed',
                secondary_model_error: secondaryModelError,
              })
            : '';
          return joinRenderedContent(
            degradedMetadata,
            baseContent,
            args.format,
          );
        }

        const metadataWithSecondary = args.include_metadata
          ? frontmatter({
              requested_url: fetchResult.requestedUrl,
              final_url: fetchResult.finalUrl,
              canonical_url: fetchResult.canonicalUrl,
              status_code: fetchResult.statusCode,
              source_content_type: fetchResult.contentType,
              charset: fetchResult.charset,
              etag: fetchResult.etag,
              last_modified: fetchResult.lastModified,
              content_length: fetchResult.contentLength,
              filename: fetchResult.filename,
              headings: fetchResult.headings,
              title: fetchResult.title,
              source_kind: fetchResult.sourceKind,
              used_llms_txt: fetchResult.usedLlmsTxt,
              extracted_main: fetchResult.extractedMain,
              redirect_chain: fetchResult.redirectChain.map(
                (step) => `${step.status} ${step.from} -> ${step.to}`,
              ),
              upgraded_to_https: fetchResult.upgradedToHttps,
              llms_probe_error: fetchResult.llmsProbeError,
              llms_probe_truncated: fetchResult.llmsProbeTruncated,
              cache_revalidated: fetchResult.cacheRevalidated,
              cache_hit: fetchResult.cacheHit ?? cacheHit,
              upstream_status_code: fetchResult.upstreamStatusCode,
              truncated: fetchResult.truncated,
              word_count: fetchResult.wordCount,
              quality_signals: fetchResult.qualitySignals,
              decoded_charset: fetchResult.decodedCharset,
              decode_fallback: fetchResult.decodeFallback,
              decode_warning: fetchResult.decodeWarning,
              secondary_model_input_truncated: secondaryRun.inputTruncated,
              secondary_model_input_chars: secondaryRun.inputChars,
              secondary_model_source_chars: secondaryRun.sourceChars,
              secondary_model: `${secondaryRun.model.providerID}/${secondaryRun.model.modelID}`,
            })
          : '';
        const secondaryRaw =
          secondaryRun.text || 'No response from secondary model.';
        const secondaryContent =
          args.format === 'html'
            ? withTruncationMarker(
                `<pre>${escapeHtml(secondaryRaw)}</pre>`,
                'html',
                false,
              )
            : withTruncationMarker(secondaryRaw, args.format, false);
        return joinRenderedContent(
          metadataWithSecondary,
          secondaryContent,
          args.format,
        );
      } finally {
        clearTimeout(timeout);
        ctx.abort.removeEventListener('abort', abortHandler);
      }
    },
  });
}
