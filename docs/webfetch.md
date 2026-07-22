# Webfetch (smartfetch)

The `webfetch` tool fetches remote URLs and returns their content with intelligent
extraction designed for documentation, static pages, and structured text. It
provides caching, `llms.txt` probing, binary content handling, and optional
secondary-model summarization.

`webfetch` is already a built-in tool in OpenCode. This plugin replaces it with
an enhanced version — the implementation lives in `src/tools/smartfetch/`, and
the tool is registered under the same `webfetch` name to override the default.

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | URL (string) | **required** | The URL to fetch. Must be a valid HTTP/HTTPS URL. |
| `format` | `"text"` \| `"markdown"` \| `"html"` | `"markdown"` | Output format for the fetched content. |
| `timeout` | number | `30` | Timeout in seconds (max `120`). |
| `prompt` | string | optional | An extraction task for the secondary model to run against the fetched content (see [Secondary Model](#secondary-model)). |
| `extract_main` | boolean | `true` | Extract main content from HTML using Mozilla Readability. When disabled, returns the full page body. |
| `prefer_llms_txt` | `"auto"` \| `"always"` \| `"never"` | `"auto"` | Prefer `/llms.txt` or `/llms-full.txt` over the page itself. `"auto"` probes only for docs-like domains (readthedocs, gitbook, netlify, vercel, etc.). |
| `include_metadata` | boolean | `true` | Include YAML frontmatter with fetch metadata (status code, content type, charset, redirect chain, cache info, etc.). |
| `save_binary` | boolean | `false` | Save binary payloads (images, PDFs, audio, video) to disk under the system temp dir. When disabled, binary content reports metadata-only. |

## Output

### Text content (HTML, plain text, llms.txt)

Returns the fetched content in the requested `format`. When `include_metadata`
is enabled (default), the response is prefixed with YAML frontmatter containing
metadata about the fetch:

```yaml
---
requested_url: "https://example.com/docs"
final_url: "https://example.com/docs"
canonical_url: "https://example.com/docs"
status_code: 200
source_content_type: "text/html"
source_kind: "html"
title: "Documentation"
headings:
  - "Getting Started"
  - "API Reference"
used_llms_txt: false
extracted_main: true
redirect_chain: []
upgraded_to_https: true
cache_hit: false
word_count: 1420
quality_signals: []
truncated: false
---
```

The `quality_signals` field flags potential issues:
- `very_short_content` — fewer than 60 words
- `possible_paywall` — content matches paywall/login keywords
- `high_boilerplate_ratio` — large HTML-to-text ratio without Readability extraction

### Binary content

Binary responses (images, PDFs, audio, video) return metadata about the file:

- Content type and size
- Filename (from `Content-Disposition` or URL path)
- Binary kind (`image`, `audio`, `video`, `pdf`, `binary`)

Two modes:

1. **Metadata-only** — content exceeds the download limit (2 MiB without
   `save_binary`, 10 MiB with it). Reports size and type without the body.
2. **Saved to disk** — when `save_binary=true`, the binary is written to
   `<tmpdir>/opencode-smartfetch/<filename>` and the response includes the
   filesystem path.

### Blocked redirects

When a cross-origin redirect is blocked by policy, the response explains which
URL was attempted and provides the redirect URL so you can fetch it directly.

## Secondary Model

When a `prompt` parameter is supplied, `webfetch` can route the fetched content
through a secondary (cheaper) model for focused extraction. This lets you ask
questions like "summarize this page" or "extract the code examples" in one step.

**How it works:**

1. Content is fetched and cached normally.
2. A temporary OpenCode session is created with all tools disabled.
3. The fetched content and your prompt are sent to a secondary model.
4. The session is cleaned up after the response.

**Which model is used** (in priority order):

1. `small_model` from the OpenCode configuration (`opencode.json` / `opencode.jsonc`)
2. The configured `explorer` agent model
3. The configured `librarian` agent model

The secondary model is called only when all of these are true:
- A `prompt` parameter is provided
- A secondary model is configured
- The fetched content has at least 25 words

If the secondary model fails (timeout, error, empty response), `webfetch`
returns the raw fetched content as a graceful fallback.

## Caching

Fetches are cached in memory with an LRU cache (50 MiB max, 15-minute TTL).
The cache key includes the URL plus behavior-affecting options (`extract_main`,
`prefer_llms_txt`, `save_binary`), so changing these re-fetches the URL.

**Revalidation:** Cache entries with `ETag` or `Last-Modified` headers support
conditional revalidation. When a stale entry exists, `webfetch` sends
`If-None-Match` / `If-Modified-Since` headers. A `304 Not Modified` response
refreshes the TTL without re-downloading.

**llms.txt validation:** Cached `llms.txt` results are validated — if the
cached entry doesn't actually look like an llms.txt response (wrong path,
HTML content, login page), it is evicted and re-fetched.

## llms.txt Probing

For documentation sites, `webfetch` probes for `/llms-full.txt` then `/llms.txt`
before falling back to the page itself.

**Probing behavior** depends on the `prefer_llms_txt` parameter:

- `"auto"` (default) — probes only when the domain looks documentation-adjacent
  (suffixes like `.readthedocs.io`, `.gitbook.io`, `docs.rs`; prefixes like
  `docs.`, `developer.`, `dev.`, `wiki.`)
- `"always"` — always probes; fails with a message if neither llms.txt variant
  exists
- `"never"` — skips probing entirely

The probe respects cross-origin redirect policy (same origin only). If the
`llms.txt` response is HTML or a login page, the probe is rejected.

## Redirect Policy

`webfetch` follows up to 10 redirects per request, but only within same-origin
scopes. Cross-origin redirects are blocked and the caller is instructed to
fetch the new URL directly.

For URLs entered as `http://`, `webfetch` first tries `https://` and falls
back to `http://` if the HTTPS attempt fails (connection error, blocked
redirect, or non-2xx status).

## Binary Detection

Content type detection follows this flow:

1. Explicit binary MIME types (`image/*`, `audio/*`, `video/*`,
   `application/pdf`, `application/zip`, `application/octet-stream`) are
   treated as binary.
2. `application/octet-stream` and known text types are re-examined — the
   first 2 KiB is scanned for null bytes and non-printable characters to
   distinguish text from binary.
3. Content declared as text/plain that looks like HTML is upgraded to
   `text/html` for better content extraction.

## Tool Timeouts

- Default timeout: 30 seconds
- Maximum timeout: 120 seconds
- llms.txt probe timeout: capped at 8 seconds within the overall timeout
- Multiple scoped timeouts run in parallel (llms.txt probing and page fetch
  are independent within a single call)

## Configuration

### Disabling

Set `webfetch.enabled` to `false` to skip registering the enhanced version and
use OpenCode's built-in `webfetch` instead:

```jsonc
{
  "webfetch": {
    "enabled": false
  }
}
```

### Dedicated secondary model

The `webfetch.model` option sets a dedicated model (or array of fallback
models) for secondary-model summarization. Takes priority over all other model
resolution sources. Accepts the same format as agent model configs:

```jsonc
{
  "webfetch": {
    "model": "openai/gpt-4o-mini"
  }
}
```

Multiple fallback models in priority order:

```jsonc
{
  "webfetch": {
    "model": ["openai/gpt-4o-mini", "anthropic/claude-3-haiku"]
  }
}
```

With optional variant:

```jsonc
{
  "webfetch": {
    "model": [
      "openai/gpt-4o-mini",
      { "id": "anthropic/claude-3-haiku", "variant": "low-latency" }
    ]
  }
}
```

Each entry is tried in turn; the first to return usable text is used.

### Secondary model fallback chain

The [secondary model](#secondary-model) is resolved from these sources (in
priority order):

1. `webfetch.model` (dedicated — highest priority, supports array for fallback)
2. `small_model` in the OpenCode config (`opencode.json` / `opencode.jsonc` at
   project or user level)
3. The plugin's `agents.explorer.model` config
4. The plugin's `agents.librarian.model` config

Example `opencode.jsonc`:

```jsonc
{
  "small_model": "openai/gpt-4o-mini"
}
```

Or in the plugin's `opencode.json` preset or project config:

```jsonc
{
  "agents": {
    "explorer": { "model": "anthropic/claude-3-haiku" },
    "librarian": { "model": "openai/gpt-4o-mini" }
  }
}
```

### Permissions

The `webfetch` permission can be configured in the plugin's permission rules.
See [Configuration](configuration.md) for details.

## Registration

The tool is registered under the name `webfetch` in `src/index.ts`, which
overrides OpenCode's built-in `webfetch` when this plugin is active.

## Implementation

The enhanced `webfetch` lives in `src/tools/smartfetch/` (the internal module is
named "smartfetch", while the public tool name is `webfetch`). It is composed of
these modules:

| Module | Responsibility |
|--------|---------------|
| `tool.ts` | Entry point — permission prompts, cache lookup, llms.txt preference logic, binary-vs-text branching, metadata emission, secondary-model integration |
| `network.ts` | URL normalization, redirect policy, charset/body decoding, header extraction, llms.txt probing, HTTP fetch with HTTPS upgrade fallback |
| `utils.ts` | HTML extraction (Mozilla Readability + Turndown), heading cleanup, markdown/text cleaning, frontmatter generation, quality signal detection |
| `cache.ts` | LRU cache keyed by URL + behavioral options, conditional revalidation, canonical URL aliasing, llms result invalidation |
| `binary.ts` | Binary content persistence to disk, MIME-to-extension mapping, safe filename allocation |
| `secondary-model.ts` | OpenCode config resolution for `small_model`, temporary session creation, content truncation, model fallback chain |
| `constants.ts` | Timeouts, size limits, docs domain heuristics, binary MIME prefixes, tool description |
