# Webfetch (smartfetch)

The `webfetch` tool fetches remote URLs and returns their content with intelligent
extraction designed for documentation, static pages, and structured text. It
provides caching, `llms.txt` probing, and binary content handling.

`webfetch` is already a built-in tool in OpenCode. This plugin replaces it with
an enhanced version — the implementation lives in `src/tools/smartfetch/`, and
the tool is registered under the same `webfetch` name to override the default.

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | URL (string) | **required** | The URL to fetch. Must be a valid HTTP/HTTPS URL. |
| `format` | `"text"` \| `"markdown"` \| `"html"` | `"markdown"` | Output format. `markdown`/`text` run Readability extraction on HTML pages (pages over 15,000 elements skip Readability and fall back to the full page); `html` returns the untouched raw page. |
| `timeout` | number | `30` | Timeout in seconds (max `120`). |
| `save_binary` | boolean | `false` | Save binary payloads (images, PDFs, audio, video) to disk under the system temp dir. When disabled, binaries return a one-line kind+size message with a retry hint. |

## Output

### Text content (HTML, plain text, llms.txt)

Returns the fetched content in the requested `format`. A minimal conditional
status header may precede the body — only keys that change the caller's next
decision are emitted, and the header is omitted entirely when there is nothing
to report:

- `title` — page title, when available
- `final_url` — only when it differs from the requested URL (redirects, HTTPS upgrade, llms.txt path; fragments are ignored)
- `truncated` — only when the body was cut off; a `[..content truncated..]`
  marker is also appended after the body
- `quality_signals` — only when non-empty:
  - `very_short_content` — fewer than 60 words
  - `possible_paywall` — content matches paywall/login keywords
  - `high_boilerplate_ratio` — large HTML-to-text ratio without Readability extraction

`format: html` never carries a status header; it is the raw page (plus the
truncation marker when truncated). Fetch observability (URL, content type,
truncation) is exposed to the UI through tool metadata instead of the text body.

### Binary content

Binary responses (images, PDFs, audio, video) return a single-line message:

1. **Metadata-only** — content exceeds the download limit (2 MiB without
   `save_binary`, 10 MiB with it) or was cut off. Reports kind and size with a
   `Re-run with save_binary=true` hint.
2. **Saved to disk** — when `save_binary=true`, the binary is written to
   `<tmpdir>/opencode-smartfetch/<filename>` and the response includes the
   filesystem path.

### Blocked redirects

When a cross-origin redirect is blocked by policy, the response explains which
URL was attempted and provides the redirect URL so you can fetch it directly.

## Caching

Fetches are cached in memory with an LRU cache (50 MiB max, 15-minute TTL).
Page cache keys include the URL and request options (`format`, `save_binary`);
changing format re-fetches the page with its preferred `Accept`. llms.txt keeps
its own text `Accept` and shares one format-independent cache entry across
pages of the same origin, probed again when stale. Permission is requested on
every call, including cache hits.

Expired entries are revalidated with `ETag`/`Last-Modified` when available.
On `304` at the same final URL, the cached body is reused and its TTL refreshed.
If a redirect changes the final URL, a fresh unconditional fetch retrieves the
new resource. Network errors never serve stale content. Expired llms.txt content
is probed again without conditionals; the probe validates responses before
caching them.

## llms.txt Probing

For documentation sites, `webfetch` automatically probes for `/llms-full.txt`
then `/llms.txt` before falling back to the page itself. Probing happens only
when the domain looks documentation-adjacent (suffixes like `.readthedocs.io`,
`.readthedocs.org`, `.gitbook.io`, `.netlify.app`, `.vercel.app`, `docs.rs`;
prefixes like `docs.`, `developer.`, `dev.`, `wiki.`)
and the requested format is `markdown` or `text` — `format: html` skips the
probe, since llms.txt is plain text rather than the raw page.

The probe respects cross-origin redirect policy (same origin only). If the
`llms.txt` response is HTML or a login page, the probe is rejected. To force
llms.txt usage on a non-docs domain, fetch `https://<site>/llms.txt` directly.

## Redirect Policy

`webfetch` follows up to 10 redirects per request, but only within same-origin
scopes. Cross-origin redirects are blocked and the caller is instructed to
fetch the new URL directly.

For URLs entered as `http://`, `webfetch` first tries `https://` and falls
back to `http://` if the HTTPS attempt fails (connection error, blocked
redirect, or non-2xx status).

If an HTTPS page returns HTTP 403 with `cf-mitigated: challenge` and sets
cookies, `webfetch` closes the response and retries once from the original URL
sending those cookies back, as any cookie-keeping client would (same user
agent and headers; redirects stay same-origin; nothing is stored). A challenge
without cookies or over plain HTTP is not retried, nor is the llms.txt probe.
A persistent challenge still reports HTTP 403 and suggests another source.

## Binary Detection

Content type detection follows this flow:

1. Explicit binary MIME types (`image/*`, `audio/*`, `video/*`,
   `application/pdf`, `application/zip`, `application/octet-stream`) are
   treated as binary.
2. Missing or generic (`application/octet-stream`) MIME types are checked for
   PNG/JPEG/GIF/WebP magic bytes before text heuristics. Otherwise generic
   binary and known text types use the first 2 KiB to distinguish text from binary.
3. Content declared as text/plain that looks like HTML is upgraded to
   `text/html` for better content extraction.

For HTML without a declared HTTP charset, the charset meta tag is inspected in
the first 2,048 bytes. Later declarations do not override the decoder fallback.

## Tool Timeouts

- Default timeout: 30 seconds
- Maximum timeout: 120 seconds
- llms.txt probe timeout: capped at 8 seconds within the overall timeout
- Multiple scoped timeouts run in parallel (llms.txt probing and page fetch
  are independent within a single call)

## Configuration

### Disabling

Set `webfetch.enabled` to `false` to skip loading the enhanced version and its
JSDOM startup probe, and use OpenCode's built-in `webfetch` instead. Listing
`webfetch` in `disabled_tools` has the same cold behavior:

```jsonc
{
  "webfetch": {
    "enabled": false
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
named "smartfetch"; the public tool name is `webfetch`). Module responsibilities
are documented by the sources in that directory.
