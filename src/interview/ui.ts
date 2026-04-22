import type { InterviewFileItem, InterviewListItem } from './types';

interface DashboardInterviewItem extends InterviewListItem {
  url: string;
  mode: string;
  resumeSlug: string;
  sessionID?: string;
  directory?: string;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ─── Shared client-side helpers ────────────────────────────────────

function clipboardHelperJs(): string {
  return `
      function copyCommand(text, btn) {
        var clip = navigator.clipboard && navigator.clipboard.writeText;
        var useFallback = function() {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        };
        if (clip) {
          clip.call(navigator.clipboard, text).catch(useFallback);
        } else {
          useFallback();
        }
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(function() {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 2000);
      }`;
}

// ─── Shared styles ─────────────────────────────────────────────────

function sharedStyles(): string {
  return `
      :root { color-scheme: dark; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
        margin: 0;
        background: #000000;
        color: #ffffff;
        line-height: 1.6;
        -webkit-font-smoothing: antialiased;
        font-size: 16px;
      }
      .wrap { max-width: 680px; margin: 0 auto; padding: 56px 24px; }
      .brand-header {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 16px;
        margin-bottom: 32px;
        text-align: center;
      }
      .brand-mark {
        object-fit: contain;
        filter: drop-shadow(0 10px 30px rgba(255,255,255,0.1));
      }
      h1 { font-size: 28px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 8px; line-height: 1.2; }
      .muted { color: rgba(255,255,255,0.5); font-size: 16px; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; font-size: 14px; }
      .resume-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .resume-cmd {
        flex: 1;
        padding: 8px 12px;
        font-size: 13px;
        border-radius: 6px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.1);
        white-space: nowrap;
        overflow-x: auto;
      }
      .copy-btn {
        flex-shrink: 0;
        padding: 8px 16px;
        border: 1px solid rgba(255,255,255,0.2);
        border-radius: 6px;
        background: transparent;
        color: rgba(255,255,255,0.8);
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .copy-btn:hover {
        background: rgba(255,255,255,0.1);
        border-color: rgba(255,255,255,0.4);
        color: #ffffff;
      }
      .copy-btn.copied {
        background: rgba(52, 211, 153, 0.15);
        border-color: #34d399;
        color: #34d399;
      }
      .footer { margin-top: 32px; text-align: center; font-size: 13px; color: rgba(255,255,255,0.4); }`;
}

// ─── Dashboard brand SVG ───────────────────────────────────────────

function brandSvg(size: number): string {
  return `<svg class="brand-mark" viewBox="0 0 144 144" role="img" aria-label="Oh My Opencode Slim" style="width:${size}px;height:${size}px">
          <rect x="12" y="12" width="120" height="120" rx="32" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.18)" stroke-width="2"/>
          <path d="M50 48h18c16 0 26 10 26 24s-10 24-26 24H50z" fill="none" stroke="white" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M74 48h20c10 0 18 8 18 18v12c0 10-8 18-18 18H74" fill="none" stroke="white" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" opacity="0.65"/>
        </svg>`;
}

export function renderDashboardPage(
  interviews: DashboardInterviewItem[],
  files: InterviewFileItem[],
  outputFolder: string,
): string {
  const activeHtml =
    interviews.length === 0
      ? ''
      : interviews
          .map((item) => {
            const isDisconnected = item.mode === 'session-disconnected';
            const statusLabel = isDisconnected ? 'disconnected' : item.status;
            const statusClass = isDisconnected
              ? 'status-file'
              : `status-${item.status}`;
            const resumeHint = isDisconnected
              ? `<div class="resume-row" style="margin-top:8px"><code class="resume-cmd">/interview ${escapeHtml(item.resumeSlug)}</code><button class="copy-btn" data-cmd="/interview ${escapeHtml(item.resumeSlug)}" title="Copy command">Copy</button></div>`
              : '';
            return `<a class="interview-card" href="${escapeHtml(item.url)}">
          <div class="card-header">
            <span class="card-idea">${escapeHtml(item.idea)}</span>
            <span class="card-status ${statusClass}">${statusLabel}</span>
          </div>
          ${item.directory ? `<div class="card-dir">${escapeHtml(item.directory)}</div>` : ''}
          <div class="card-meta">
            <span>${escapeHtml(new Date(item.createdAt).toLocaleString())}</span>
          </div>
          ${resumeHint}
        </a>`;
          })
          .join('\n');

  // Dedup: skip files whose sessionID matches an active/recovered interview.
  // These are already visible in the "Interviews" section above.
  const activeSessionIDs = new Set(
    interviews
      .map((i) => i.sessionID)
      .filter((sid): sid is string => typeof sid === 'string'),
  );
  const unrecoveredFiles = files.filter((f) => {
    if (f.sessionID && activeSessionIDs.has(f.sessionID)) return false;
    return true;
  });

  const filesHtml =
    unrecoveredFiles.length === 0
      ? ''
      : unrecoveredFiles
          .map(
            (item) =>
              `<div class="interview-card file-card">
          <div class="card-header">
            <span class="card-idea">${escapeHtml(item.title)}</span>
            <span class="card-status status-file">saved</span>
          </div>
          ${item.directory ? `<div class="card-dir">${escapeHtml(item.directory)}</div>` : ''}
          <div class="card-summary">${escapeHtml(item.summary)}</div>
          <div class="resume-row">
            <code class="resume-cmd">${escapeHtml(item.resumeCommand)}</code>
            <button class="copy-btn" data-cmd="${escapeHtml(item.resumeCommand)}" title="Copy command">Copy</button>
          </div>
        </div>`,
          )
          .join('\n');

  const totalCount = interviews.length + unrecoveredFiles.length;
  const emptyState =
    totalCount === 0
      ? '<p class="muted" style="text-align:center;padding:48px 0">No interviews yet. Start one with <code>/interview</code> in your OpenCode session.</p>'
      : '';

  const activeSection =
    interviews.length > 0 ? `<h2>Interviews</h2>${activeHtml}` : '';

  const fileSection =
    unrecoveredFiles.length > 0
      ? `<h2>Files without session</h2><p class="muted file-hint">Resume with the command in any OpenCode session.</p>${filesHtml}`
      : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Interviews</title>
    <style>
      ${sharedStyles()}
      .brand-mark { width: 96px; height: 96px; }
      h2 { font-size: 18px; font-weight: 500; letter-spacing: 0.05em; text-transform: uppercase; color: rgba(255,255,255,0.4); margin-bottom: 16px; margin-top: 40px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 12px; }
      h2:first-of-type { margin-top: 0; }
      .file-hint { font-size: 14px; margin-bottom: 16px; margin-top: -8px; }

      .interview-card {
        display: block;
        background: rgba(255,255,255,0.02);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 8px;
        padding: 20px 24px;
        margin-bottom: 12px;
        text-decoration: none;
        color: inherit;
        transition: all 0.2s ease;
      }
      .interview-card:hover {
        background: rgba(255,255,255,0.06);
        border-color: rgba(255,255,255,0.3);
        transform: translateX(4px);
      }
      .file-card {
        cursor: default;
      }
      .file-card:hover {
        transform: none;
      }
      .card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
      .card-idea { font-size: 17px; font-weight: 500; line-height: 1.4; flex: 1; }
      .card-status {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 4px 10px;
        border-radius: 999px;
        font-weight: 600;
        flex-shrink: 0;
      }
      .status-active { background: rgba(52, 211, 153, 0.15); color: #34d399; }
      .status-abandoned { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.4); }
      .status-file { background: rgba(96, 165, 250, 0.15); color: #60a5fa; }
      .card-meta { font-size: 13px; color: rgba(255,255,255,0.4); }
      .card-summary { font-size: 14px; color: rgba(255,255,255,0.5); margin-bottom: 12px; line-height: 1.5; }
      .card-dir { font-size: 12px; color: rgba(255,255,255,0.3); margin-bottom: 8px; font-family: monospace; word-break: break-all; }

      .update-banner {
        position: fixed;
        top: -56px;
        left: 0; right: 0;
        background: rgba(96, 165, 250, 0.95);
        color: #fff;
        text-align: center;
        padding: 14px 24px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        z-index: 200;
        transition: top 0.3s ease;
        backdrop-filter: blur(8px);
      }
      .update-banner.visible { top: 0; }
      .update-banner:hover { background: rgba(96, 165, 250, 1); }
      .info-box {
        font-size: 13px;
        color: rgba(255,255,255,0.45);
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 8px;
        padding: 16px 20px;
        margin-bottom: 40px;
        line-height: 1.7;
      }
      .info-box strong { color: rgba(255,255,255,0.65); font-weight: 500; }
      .info-box code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        background: rgba(255,255,255,0.08);
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 12px;
        word-break: break-all;
      }
      .settings-row {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-top: 12px;
        flex-wrap: wrap;
      }
      .settings-row label {
        font-size: 13px;
        color: rgba(255,255,255,0.5);
        white-space: nowrap;
      }
      .settings-row select, .settings-row input[type="text"] {
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.15);
        color: #fff;
        border-radius: 4px;
        padding: 6px 10px;
        font-size: 13px;
        font-family: inherit;
      }
      .settings-row input[type="text"] {
        flex: 1;
        min-width: 200px;
      }
      .settings-row select:focus, .settings-row input[type="text"]:focus {
        border-color: rgba(255,255,255,0.4);
        outline: none;
      }
      .small-btn {
        padding: 6px 14px;
        border: 1px solid rgba(255,255,255,0.2);
        border-radius: 4px;
        background: transparent;
        color: rgba(255,255,255,0.8);
        font-size: 13px;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .small-btn:hover {
        background: rgba(255,255,255,0.1);
        border-color: rgba(255,255,255,0.4);
        color: #fff;
      }
      .folder-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-top: 8px;
      }
      .folder-item {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        color: rgba(255,255,255,0.5);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .folder-item button {
        padding: 2px 8px;
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 3px;
        background: transparent;
        color: rgba(255,255,255,0.4);
        font-size: 11px;
        cursor: pointer;
      }
      .folder-item button:hover {
        border-color: rgba(255,100,100,0.5);
        color: rgba(255,100,100,0.8);
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="brand-header">
        ${brandSvg(96)}
        <h1>Interviews</h1>
        <p class="muted">${totalCount} item${totalCount === 1 ? '' : 's'}</p>
      </div>
      <div class="info-box">
        <strong>Interviews</strong> — live sessions and recovered files. State is pushed from OpenCode sessions to this dashboard.<br>
        <strong>Files without session</strong> — <code>.md</code> files in <code>${escapeHtml(outputFolder)}</code> with no frontmatter. Resume with <code>/interview &lt;name&gt;</code>.
      </div>
      <details style="margin-bottom:24px">
        <summary style="cursor:pointer;font-size:13px;color:rgba(255,255,255,0.4);user-select:none">Settings</summary>
        <div style="margin-top:12px">
          <div class="settings-row">
            <label for="scanDays">Scan sessions from last</label>
            <select id="scanDays">
              <option value="1">1 day</option>
              <option value="7">7 days</option>
              <option value="30" selected>30 days</option>
              <option value="90">90 days</option>
              <option value="0">All time</option>
            </select>
            <button class="small-btn" id="rescanBtn">Rescan</button>
          </div>
          <div class="settings-row">
            <input type="text" id="addFolderInput" placeholder="/path/to/project" />
            <button class="small-btn" id="addFolderBtn">Add Folder</button>
          </div>
          <div class="folder-list" id="folderList"></div>
        </div>
      </details>
      ${emptyState}
      ${activeSection}
      ${fileSection}
      <div class="footer">OH MY OPENCODE SLIM</div>
    </div>
    <div class="update-banner" id="updateBanner">Dashboard updated — tap to refresh</div>
    <script>
      ${clipboardHelperJs()}
      document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          copyCommand(btn.dataset.cmd, btn);
        });
      });

      let lastSig = '';
      let bannerTimer = null;
      // Use health endpoint for change detection (no auth needed, shows counts)
      (async () => { try { const r = await fetch('/api/health'); if (r.ok) lastSig = await r.text(); } catch {} })();
      setInterval(async () => {
        try {
          const res = await fetch('/api/health');
          if (!res.ok) return;
          const sig = await res.text();
          if (sig !== lastSig) {
            lastSig = sig;
            const banner = document.getElementById('updateBanner');
            banner.classList.add('visible');
            if (bannerTimer) clearTimeout(bannerTimer);
            bannerTimer = setTimeout(() => banner.classList.remove('visible'), 30000);
          }
        } catch {}
      }, 15000);
      document.getElementById('updateBanner').addEventListener('click', () => location.reload());

      // Settings: load current state
      (async () => {
        try {
          const r = await fetch('/api/settings');
          if (!r.ok) return;
          const s = await r.json();
          const sel = document.getElementById('scanDays');
          if (sel && s.scanDays !== undefined) sel.value = String(s.scanDays);
          renderFolderList(s.folders || []);
        } catch {}
      })();

      function renderFolderList(folders) {
        const list = document.getElementById('folderList');
        if (!list) return;
        list.innerHTML = '';
        folders.forEach(function(dir) {
          const item = document.createElement('div');
          item.className = 'folder-item';
          const span = document.createElement('span');
          span.textContent = dir;
          span.style.flex = '1';
          const btn = document.createElement('button');
          btn.textContent = 'Remove';
          btn.addEventListener('click', async function() {
            await fetch('/api/settings', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ removeFolder: dir })
            });
            location.reload();
          });
          item.appendChild(span);
          item.appendChild(btn);
          list.appendChild(item);
        });
      }

      document.getElementById('rescanBtn')?.addEventListener('click', async function() {
        const days = parseInt(document.getElementById('scanDays').value, 10);
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scanDays: days, discover: true })
        });
        location.reload();
      });

      document.getElementById('addFolderBtn')?.addEventListener('click', async function() {
        const input = document.getElementById('addFolderInput');
        const dir = input.value.trim();
        if (!dir) return;
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ addFolder: dir })
        });
        input.value = '';
        location.reload();
      });
    </script>
  </body>
</html>`;
}

export function renderInterviewPage(
  interviewId: string,
  resumeSlug: string,
): string {
  const safeTitle = escapeHtml(interviewId);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Interview ${safeTitle}</title>
    <style>
      ${sharedStyles()}
      .brand-mark { width: 144px; height: 144px; }
      h1 { font-size: 32px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 12px; line-height: 1.2; }
      h2 { font-size: 18px; font-weight: 500; letter-spacing: 0.05em; text-transform: uppercase; color: rgba(255,255,255,0.4); margin-bottom: 24px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 12px; }
      h3 { font-size: 18px; font-weight: 500; margin-bottom: 16px; line-height: 1.4; }
      p { margin-top: 0; }
      .meta { display: flex; align-items: center; justify-content: space-between; font-size: 13px; color: rgba(255,255,255,0.4); margin-bottom: 16px; letter-spacing: 0.05em; text-transform: uppercase; }
      
       .file-path-container {
         font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
         font-size: 13px;
         color: rgba(255,255,255,0.6);
         background: rgba(255,255,255,0.05);
         padding: 8px 12px;
         border-radius: 6px;
         margin-bottom: 12px;
         display: flex;
         align-items: center;
         gap: 8px;
         border: 1px solid rgba(255,255,255,0.08);
       }
      .file-path-icon {
        opacity: 0.5;
      }
      .download-btn {
        margin-left: auto;
        background: transparent;
        border: 1px solid rgba(255,255,255,0.2);
        color: rgba(255,255,255,0.6);
        border-radius: 4px;
        padding: 4px 10px;
        font-size: 12px;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .download-btn:hover {
        border-color: rgba(255,255,255,0.5);
        color: #ffffff;
       }

       .question {
        background: rgba(255,255,255,0.02); 
        border: 1px solid rgba(255,255,255,0.1); 
        border-left: 1px solid rgba(255,255,255,0.1);
        border-radius: 6px; 
        padding: 28px; 
        margin-bottom: 32px; 
        transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      .question:focus-within {
        border-color: rgba(255,255,255,0.3);
      }
      
      /* Make active question much clearer */
      .question.active-question {
        background: rgba(255,255,255,0.04);
        border-color: rgba(255,255,255,0.4);
        border-left: 4px solid #ffffff;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.1);
        transform: translateX(4px);
      }
      
      .options { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
      
      .option { 
        border: 1px solid rgba(255,255,255,0.1); 
        background: transparent; 
        color: inherit; 
        border-radius: 6px; 
        padding: 14px 18px; 
        cursor: pointer; 
        text-align: left;
        font-size: 16px;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
      }
      .option:hover {
        background: rgba(255,255,255,0.06);
        border-color: rgba(255,255,255,0.3);
      }
      .option.selected { 
        background: #ffffff; 
        color: #000000; 
        border-color: #ffffff; 
        font-weight: 500;
      }
      
      .shortcut {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: rgba(255,255,255,0.1);
        color: rgba(255,255,255,0.8);
        border-radius: 4px;
        min-width: 20px;
        height: 20px;
        padding: 0 4px;
        font-size: 12px;
        margin-right: 12px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .option.selected .shortcut {
        background: rgba(0,0,0,0.15);
        color: rgba(0,0,0,0.9);
      }
       
      .option-text {
        flex: 1;
        line-height: 1.4;
      }

      .recommended-badge {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        background: rgba(255,255,255,0.15);
        color: rgba(255,255,255,0.9);
        padding: 4px 8px;
        border-radius: 999px;
        margin-left: 12px;
        font-weight: 600;
      }
      .option.selected .recommended-badge {
        background: rgba(0,0,0,0.15);
        color: rgba(0,0,0,0.8);
      }

      .submit-shortcut {
        display: inline-block;
        margin-left: 10px;
        padding: 3px 8px;
        border-radius: 999px;
        background: rgba(0,0,0,0.08);
        color: rgba(0,0,0,0.7);
        font-size: 12px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      
      textarea { 
        width: 100%; 
        box-sizing: border-box;
        min-height: 140px; 
        border-radius: 6px; 
        border: 1px solid rgba(255,255,255,0.15); 
        background: rgba(0,0,0,0.6); 
        color: inherit; 
        padding: 16px; 
        font-family: inherit;
        font-size: 16px;
        line-height: 1.5;
        resize: vertical;
        outline: none;
        transition: border-color 0.2s ease;
      }
      textarea:focus {
        border-color: rgba(255,255,255,0.5);
        box-shadow: 0 0 0 1px rgba(255,255,255,0.1);
      }

      .hidden-textarea {
        display: none;
      }
      
      button.primary { 
        background: #ffffff; 
        color: #000000; 
        border: 0; 
        border-radius: 6px; 
        padding: 16px 24px; 
        font-size: 16px;
        font-weight: 600;
        cursor: pointer; 
        width: 100%;
        transition: opacity 0.2s ease, transform 0.1s ease;
      }
      button.primary:hover:not(:disabled) {
        opacity: 0.9;
        transform: translateY(-1px);
      }
      button.primary:active:not(:disabled) {
        transform: translateY(1px);
      }
      button.primary:disabled { 
        opacity: 0.3; 
        cursor: not-allowed; 
      }
      
      .footer {
        margin-top: 32px;
        text-align: center;
        font-size: 13px;
        color: rgba(255,255,255,0.4);
      }
      .back-link {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: rgba(255,255,255,0.5);
        text-decoration: none;
        font-size: 14px;
        padding: 8px 0;
        transition: color 0.2s ease;
        position: relative;
        z-index: 200;
      }
      .back-link:hover { color: #ffffff; }
      .status-completed { color: #34d399; }

      /* Loading State Overlay */
      .loading-overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0, 0, 0, 0.85);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        z-index: 100;
        opacity: 0;
        pointer-events: none;
        backdrop-filter: blur(8px);
        transition: opacity 0.3s ease;
      }
      .loading-overlay.active {
        opacity: 1;
        pointer-events: all;
      }
      
      .loading-overlay .status-text {
        font-size: 15px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: #ffffff;
        font-weight: 500;
      }

      /* ── Completed Mode ─────────────────────────────────────────── */
      .section-label {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: rgba(255,255,255,0.28);
        margin-bottom: 14px;
      }
      .spec-block {
        background: rgba(255,255,255,0.02);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 6px;
        padding: 20px 24px;
        margin-bottom: 32px;
        color: rgba(255,255,255,0.72);
        font-size: 15px;
        line-height: 1.75;
      }
      .spec-block p { margin: 0 0 10px; }
      .spec-block p:last-child { margin-bottom: 0; }
      .spec-block strong { color: rgba(255,255,255,0.95); font-weight: 600; }
      .spec-block code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13px;
        background: rgba(255,255,255,0.08);
        padding: 1px 5px;
        border-radius: 3px;
      }
      .qa-list { margin-bottom: 12px; }
      .qa-card {
        background: rgba(255,255,255,0.02);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 6px;
        padding: 18px 22px;
        margin-bottom: 10px;
      }
      .qa-row { display: flex; gap: 14px; align-items: flex-start; }
      .qa-row + .qa-row { margin-top: 12px; }
      .qa-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        font-size: 10px;
        font-weight: 700;
        flex-shrink: 0;
        margin-top: 2px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .qa-badge-q { background: rgba(255,255,255,0.12); color: rgba(255,255,255,0.85); }
      .qa-badge-a { background: rgba(52,211,153,0.15); color: #34d399; }
      .qa-divider { height: 1px; background: rgba(255,255,255,0.05); margin: 12px 0; }
      .qa-text { font-size: 15px; line-height: 1.55; padding-top: 2px; }
      .qa-text-q { color: rgba(255,255,255,0.82); }
      .qa-text-a { color: rgba(255,255,255,0.52); }
      .qa-empty {
        color: rgba(255,255,255,0.25);
        font-size: 14px;
        text-align: center;
        padding: 20px 0;
        font-style: italic;
      }
      .nudge-actions {
        display: flex;
        gap: 12px;
        margin-top: 32px;
        margin-bottom: 8px;
      }
      .nudge-btn {
        flex: 1;
        background: transparent;
        border: 1px solid rgba(255,255,255,0.15);
        color: rgba(255,255,255,0.65);
        border-radius: 6px;
        padding: 13px 16px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        letter-spacing: 0.01em;
      }
      .nudge-btn:hover:not(:disabled) {
        border-color: rgba(255,255,255,0.4);
        color: #ffffff;
        background: rgba(255,255,255,0.04);
      }
      .nudge-btn.nudge-confirm {
        border-color: rgba(52,211,153,0.25);
        color: rgba(52,211,153,0.8);
      }
      .nudge-btn.nudge-confirm:hover:not(:disabled) {
        border-color: rgba(52,211,153,0.6);
        color: #34d399;
        background: rgba(52,211,153,0.05);
      }
      .nudge-btn:disabled { opacity: 0.3; cursor: not-allowed; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <a href="/" class="back-link">← All Interviews</a>
      <div class="brand-header">
        ${brandSvg(144)}
      </div>
      <h1 id="idea">Connecting...</h1>
      <p class="muted" id="summary">Preparing interview session</p>
      
      <div class="meta">
        <span id="status">INITIALIZING</span>
        <span>OH MY OPENCODE SLIM</span>
      </div>
      
      <div id="filePathContainer" class="file-path-container" style="display: none;">
        <span class="file-path-icon">📄</span>
        <span id="markdownPath"></span>
        <button id="downloadBtn" class="download-btn" type="button">Download</button>
      </div>

      <div id="resumeRow" class="resume-row" style="display:none;">
        <code id="resumeCmd" class="resume-cmd"></code>
        <button class="copy-btn" id="copyResumeBtn" type="button">Copy</button>
      </div>

      <div id="questions"></div>

      <div id="nudgeActions" class="nudge-actions" style="display:none;">
        <button class="nudge-btn" id="moreQuestionsBtn" type="button">Ask more questions</button>
        <button class="nudge-btn nudge-confirm" id="confirmCompleteBtn" type="button">Confirm complete ✓</button>
      </div>
      
       <button class="primary" id="submitButton" disabled>Submit Answers <span class="submit-shortcut">⌘↵</span></button>
      
      <div class="footer" id="submitStatus"></div>
    </div>
    
    <div class="loading-overlay" id="loadingOverlay">
      <div class="status-text" id="loadingText">Processing...</div>
    </div>

    <script>
      ${clipboardHelperJs()}
      const interviewId = ${JSON.stringify(interviewId).replace(/</g, '\\u003c')};
      const resumeSlug = ${JSON.stringify(resumeSlug).replace(/</g, '\\u003c')};
      const state = { data: null, answers: {}, activeQuestionIndex: 0, lastSig: null, customMode: {} };

      function updateSubmitButton() {
        const button = document.getElementById('submitButton');
        if (!state.data) {
          button.disabled = true;
          return;
        }

        const questions = state.data.questions || [];
        const allAnswered = questions.every((question) =>
          (state.answers[question.id] || '').trim().length > 0,
        );
        button.disabled = state.data.isBusy || !questions.length || !allAnswered;
        const hideSubmit = ['completed', 'session-disconnected'];
        button.style.display = hideSubmit.includes(state.data.mode) ? 'none' : '';
        
        const overlay = document.getElementById('loadingOverlay');
        const overlayText = document.getElementById('loadingText');
        if (state.data.isBusy) {
          overlay.classList.add('active');
          overlayText.textContent = "Agent Thinking...";
        } else {
          overlay.classList.remove('active');
        }
      }

      function getOptionButtonId(questionId, index) {
        return 'opt-' + questionId + '-' + index;
      }

      function createOption(question, option, index, isCustom) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'option';
        button.id = getOptionButtonId(question.id, index);
        
        const shortcut = index < 9 ? (index + 1) : '';
        if (shortcut) {
          const kbd = document.createElement('span');
          kbd.className = 'shortcut';
          kbd.textContent = shortcut;
          button.appendChild(kbd);
        }
        
        const text = document.createElement('span');
        text.className = 'option-text';
        text.textContent = isCustom ? 'Custom' : option;
        button.appendChild(text);

        // Visual marking for suggested/recommended answers
        if (!isCustom && question.suggested === option) {
          const badge = document.createElement('span');
          badge.className = 'recommended-badge';
          badge.textContent = 'Recommended';
          button.appendChild(badge);
        }

        button.addEventListener('click', () => {
          const questions = state.data?.questions || [];
          const qIdx = questions.findIndex(q => q.id === question.id);
          if (qIdx !== -1) {
             state.activeQuestionIndex = qIdx;
             updateActiveQuestionFocus();
          }
          handleOptionSelect(question, option, isCustom);
        });
        
        return button;
      }

      function handleOptionSelect(question, option, isCustom) {
        const textarea = document.getElementById('answer-' + question.id);
        
        if (isCustom) {
          state.customMode[question.id] = true;
          state.answers[question.id] = state.customMode[question.id]
            ? state.answers[question.id] || ''
            : '';
          updateTextareaVisibility(question.id);
          updateOptionsDOM(question.id);
          if (textarea) {
            textarea.focus();
          }
        } else {
          state.customMode[question.id] = false;
          state.answers[question.id] = option;
          updateTextareaVisibility(question.id);
          advanceToNextQuestion(question.id);
        }
        
        updateSubmitButton();
        updateOptionsDOM(question.id);
      }

      function updateTextareaVisibility(questionId) {
        const textarea = document.getElementById('answer-' + questionId);
        if (!textarea) return;
        if (state.customMode[questionId]) {
          textarea.classList.remove('hidden-textarea');
        } else {
          textarea.classList.add('hidden-textarea');
        }
      }

      function advanceToNextQuestion(currentQuestionId) {
        const questions = state.data?.questions || [];
        const currentIndex = questions.findIndex(q => q.id === currentQuestionId);
        
        if (currentIndex >= 0 && currentIndex < questions.length - 1) {
          state.activeQuestionIndex = currentIndex + 1;
          updateActiveQuestionFocus();
          const nextQuestion = questions[currentIndex + 1];
          const nextEl = document.getElementById('question-' + nextQuestion.id);
          if (nextEl) {
            nextEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        } else if (currentIndex === questions.length - 1) {
          const submitBtn = document.getElementById('submitButton');
          if (submitBtn && !submitBtn.disabled) {
            submitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      }

      function updateOptionsDOM(questionId) {
        const question = (state.data?.questions || []).find(q => q.id === questionId);
        if (!question) return;
        
        const predefined = question.options || [];
        const currentAnswer = state.answers[question.id];
        
        predefined.forEach((opt, idx) => {
           const btn = document.getElementById(getOptionButtonId(questionId, idx));
           if (btn) {
              if (currentAnswer === opt) btn.classList.add('selected');
              else btn.classList.remove('selected');
           }
        });
        
        const customBtn = document.getElementById(getOptionButtonId(questionId, predefined.length));
        if (customBtn) {
           if (state.customMode[questionId]) {
               customBtn.classList.add('selected');
            } else {
               customBtn.classList.remove('selected');
           }
        }
      }

      function updateActiveQuestionFocus() {
         const questions = state.data?.questions || [];
         questions.forEach((q, idx) => {
            const wrapper = document.getElementById('question-' + q.id);
            if (wrapper) {
               if (idx === state.activeQuestionIndex) {
                  wrapper.classList.add('active-question');
               } else {
                  wrapper.classList.remove('active-question');
               }
            }
         });
      }

      document.addEventListener('keydown', (e) => {
        const isSubmitShortcut =
          (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ||
          (e.key === 's' && (e.metaKey || e.ctrlKey));
        if (isSubmitShortcut) {
          const submitBtn = document.getElementById('submitButton');
          if (submitBtn && !submitBtn.disabled) {
            submitBtn.click();
            e.preventDefault();
          }
          return;
        }

        if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        const questions = state.data?.questions || [];
        if (!questions.length) return;

         const num = parseInt(e.key, 10);
         if (num >= 1 && num <= 9) {
          const activeQ = questions[state.activeQuestionIndex];
          if (!activeQ) return;
          
          const options = activeQ.options || [];
          if (!options.length) return;

          const idx = num - 1;
          
          if (idx < options.length) {
            handleOptionSelect(activeQ, options[idx], false);
            e.preventDefault();
          } else if (idx === options.length) {
            handleOptionSelect(activeQ, 'Custom', true);
            e.preventDefault();
         }

        }
        
        if (e.key === 'ArrowDown') {
           if (state.activeQuestionIndex < questions.length - 1) {
              state.activeQuestionIndex++;
              updateActiveQuestionFocus();
              const wrapper = document.getElementById('question-' + questions[state.activeQuestionIndex].id);
              if (wrapper) wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
              e.preventDefault();
           }
        }
        if (e.key === 'ArrowUp') {
           if (state.activeQuestionIndex > 0) {
              state.activeQuestionIndex--;
              updateActiveQuestionFocus();
              const wrapper = document.getElementById('question-' + questions[state.activeQuestionIndex].id);
              if (wrapper) wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
              e.preventDefault();
           }
        }
      });

      // ── Completed-mode helpers ───────────────────────────────────

      function parseDocument(doc) {
        if (!doc) return { spec: '', qaPairs: [] };
        // Strip frontmatter (---...---) to prevent frontmatter lines from
        // matching section headers or being parsed as content
        let content = doc;
        const fmMatch = content.match(/^---\\n[\\s\\S]*?\\n---\\n/);
        if (fmMatch) content = content.slice(fmMatch[0].length);
        const lines = content.split('\\n');
        const specLines = [];
        const qaLines = [];
        let section = null;
        for (const line of lines) {
          if (/^## Current spec\\b/i.test(line)) { section = 'spec'; continue; }
          if (/^## Q&A history\\b/i.test(line)) { section = 'qa'; continue; }
          if (/^#{1,6} /.test(line)) { section = null; continue; }
          if (section === 'spec') specLines.push(line);
          else if (section === 'qa') qaLines.push(line);
        }
        const qaPairs = [];
        let current = null;
        for (const line of qaLines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('Q: ')) {
            if (current) qaPairs.push(current);
            current = { q: trimmed.slice(3), a: '' };
          } else if (trimmed.startsWith('A: ') && current) {
            current.a = trimmed.slice(3);
          } else if (trimmed && current && current.a) {
            current.a += ' ' + trimmed;
          }
        }
        if (current) qaPairs.push(current);
        return { spec: specLines.join('\\n').trim(), qaPairs };
      }

      // simpleMarkdown: safe because escaping happens BEFORE markdown
      // processing. Adding raw HTML output from user content would break
      // this safety — always use textContent for user data.
      function simpleMarkdown(text) {
        if (!text) return '';
        const escaped = text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        const formatted = escaped
          .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
          .replace(/\`([^\`]+)\`/g, '<code>$1</code>');
        const paragraphs = formatted.split(/\\n\\n+/).filter(p => p.trim());
        return paragraphs.map(p => \`<p>\${p.replace(/\\n/g, '<br>')}</p>\`).join('');
      }

      function renderCompletedView(data) {
        const container = document.getElementById('questions');
        const { spec, qaPairs } = parseDocument(data.document);
        const frag = document.createDocumentFragment();

        // Spec section
        if (spec) {
          const specLabel = document.createElement('div');
          specLabel.className = 'section-label';
          specLabel.textContent = 'Current Spec';
          frag.appendChild(specLabel);
          const specBlock = document.createElement('div');
          specBlock.className = 'spec-block';
          specBlock.innerHTML = simpleMarkdown(spec);
          frag.appendChild(specBlock);
        }

        // Q&A section
        const qaLabel = document.createElement('div');
        qaLabel.className = 'section-label';
        qaLabel.textContent = 'Q&A History';
        frag.appendChild(qaLabel);

        if (!qaPairs.length) {
          const empty = document.createElement('p');
          empty.className = 'qa-empty';
          empty.textContent = 'No Q&A recorded.';
          frag.appendChild(empty);
        } else {
          const qaList = document.createElement('div');
          qaList.className = 'qa-list';
          for (const pair of qaPairs) {
            const card = document.createElement('div');
            card.className = 'qa-card';

            const qRow = document.createElement('div');
            qRow.className = 'qa-row';
            const qBadge = document.createElement('span');
            qBadge.className = 'qa-badge qa-badge-q';
            qBadge.textContent = 'Q';
            const qText = document.createElement('span');
            qText.className = 'qa-text qa-text-q';
            qText.textContent = pair.q;
            qRow.appendChild(qBadge);
            qRow.appendChild(qText);
            card.appendChild(qRow);

            const divider = document.createElement('div');
            divider.className = 'qa-divider';
            card.appendChild(divider);

            const aRow = document.createElement('div');
            aRow.className = 'qa-row';
            const aBadge = document.createElement('span');
            aBadge.className = 'qa-badge qa-badge-a';
            aBadge.textContent = 'A';
            const aText = document.createElement('span');
            aText.className = 'qa-text qa-text-a';
            aText.textContent = pair.a || '—';
            aRow.appendChild(aBadge);
            aRow.appendChild(aText);
            card.appendChild(aRow);

            qaList.appendChild(card);
          }
          frag.appendChild(qaList);
        }

        container.replaceChildren(frag);
      }

      function renderQuestions(questions) {
        const sig = JSON.stringify([questions, state.data?.mode]);
        const container = document.getElementById('questions');

        if (state.lastSig === sig) {
          questions.forEach((q) => updateOptionsDOM(q.id));
          updateActiveQuestionFocus();
          return;
        }
        
        state.lastSig = sig;
        container.replaceChildren();

        if (!questions.length && !state.data?.isBusy) {
          const doneModes = ['completed', 'session-disconnected'];
          if (doneModes.includes(state.data?.mode)) {
            renderCompletedView(state.data);
          } else {
            const empty = document.createElement('p');
            empty.className = 'muted';
            empty.style.textAlign = 'center';
            empty.style.padding = '48px 0';
            empty.textContent = 'No active questions right now.';
            container.appendChild(empty);
          }
          return;
        }

        questions.forEach((question, idx) => {
          const wrapper = document.createElement('div');
          wrapper.className = 'question';
          wrapper.id = 'question-' + question.id;
          
           if (question.suggested && !state.answers[question.id]) {
             state.answers[question.id] = question.suggested;
             state.customMode[question.id] = false;
            }

          const title = document.createElement('h3');
          title.textContent = question.question;
          wrapper.appendChild(title);

          const predefined = question.options || [];
          if (predefined.length) {
            const options = document.createElement('div');
            options.className = 'options';
            predefined.forEach((option, optIdx) => {
              options.appendChild(createOption(question, option, optIdx, false));
            });
            options.appendChild(createOption(question, 'Custom', predefined.length, true));
            wrapper.appendChild(options);
          }

           const textarea = document.createElement('textarea');
           textarea.id = 'answer-' + question.id;
           textarea.placeholder = 'Type your answer here...';
           textarea.value = state.customMode[question.id] ? (state.answers[question.id] || '') : '';
           if (!state.customMode[question.id]) {
             textarea.classList.add('hidden-textarea');
           }
           
           textarea.addEventListener('focus', () => {
              state.activeQuestionIndex = idx;
            updateActiveQuestionFocus();
          });
          
          textarea.addEventListener('input', () => {
            state.answers[question.id] = textarea.value;
            updateSubmitButton();
            updateOptionsDOM(question.id);
          });
          wrapper.appendChild(textarea);

          container.appendChild(wrapper);
        });
        
        updateActiveQuestionFocus();
        questions.forEach(q => updateOptionsDOM(q.id));
      }

      function render(data) {
        state.data = data;
        document.getElementById('idea').textContent = data.interview.idea || 'Interview';
        const doneModes = ['completed', 'session-disconnected'];
        const isDone = doneModes.includes(data.mode);
        const summaryEl = document.getElementById('summary');
        if (isDone) {
          summaryEl.style.display = 'none';
        } else {
          summaryEl.style.display = '';
          summaryEl.textContent = data.summary || 'Session in progress.';
        }
        const statusEl = document.getElementById('status');
        statusEl.textContent = data.mode.toUpperCase();
        statusEl.className = isDone ? 'status-completed' : '';
        
        // Render Markdown Path — always visible in completed mode
        const pathContainer = document.getElementById('filePathContainer');
        const pathElement = document.getElementById('markdownPath');
        const mdPath = data.markdownPath || (data.interview && data.interview.markdownPath);
        if (mdPath || isDone) {
          if (mdPath) {
            // Show just the filename for absolute paths
            pathElement.textContent = mdPath.startsWith('/')
              ? mdPath.split('/').pop() || mdPath
              : mdPath;
          } else {
            pathElement.textContent = 'interview.md';
          }
          pathContainer.style.display = 'flex';
        } else {
          pathContainer.style.display = 'none';
        }

        // Resume command — only in session-disconnected mode
        var resumeRow = document.getElementById('resumeRow');
        if (resumeRow) {
          var showResume = data.mode === 'session-disconnected';
          resumeRow.style.display = showResume ? 'flex' : 'none';
         if (showResume) {
             document.getElementById('resumeCmd').textContent = '/interview ' + resumeSlug;
          }
        }

        // Nudge actions — only for completed (live session)
        // session-disconnected can't nudge (no session to receive it)
        const nudgeActions = document.getElementById('nudgeActions');
        const moreBtn = document.getElementById('moreQuestionsBtn');
        const confirmBtn = document.getElementById('confirmCompleteBtn');
        const canNudge = data.mode === 'completed';
        if (nudgeActions) nudgeActions.style.display = canNudge ? 'flex' : 'none';
        if (moreBtn) moreBtn.disabled = data.isBusy;
        if (confirmBtn) confirmBtn.disabled = data.isBusy;
        
        renderQuestions(data.questions || []);
        updateSubmitButton();
      }

      async function refresh() {
        const url = '/api/interviews/' + encodeURIComponent(interviewId) + '/state';
        const response = await fetch(url);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to load state');
        render(data);
      }

      function scrollToTop() {
        window.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
      }

      document.getElementById('submitButton').addEventListener('click', async () => {
        if (!state.data) return;
        const answers = (state.data.questions || []).map((question) => {
          return {
            questionId: question.id,
            answer: (state.answers[question.id] || '').trim(),
          };
        });

        const overlay = document.getElementById('loadingOverlay');
        const overlayText = document.getElementById('loadingText');
        overlay.classList.add('active');
        overlayText.textContent = "Submitting Answers...";
        scrollToTop();

        try {
          const response = await fetch('/api/interviews/' + encodeURIComponent(interviewId) + '/answers', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ answers }),
          });
          const payload = await response.json();
          document.getElementById('submitStatus').textContent = payload.message || (response.ok ? 'Answers submitted successfully.' : 'Submission failed.');
        } catch (err) {
          document.getElementById('submitStatus').textContent = 'Error submitting answers.';
        }
        try {
          await refresh();
        } catch (_error) {
          overlay.classList.remove('active');
        }
      });

      document.getElementById('downloadBtn').addEventListener('click', () => {
        if (!state.data || !state.data.document) return;
        const blob = new Blob([state.data.document], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const mdPath = state.data.markdownPath || 'interview.md';
        a.download = mdPath.split('/').pop() || 'interview.md';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      });

      document.getElementById('copyResumeBtn').addEventListener('click', function(e) {
        e.stopPropagation();
        e.preventDefault();
        var cmd = document.getElementById('resumeCmd').textContent;
        if (cmd) copyCommand(cmd, this);
      });

      async function sendNudge(action) {
        const moreBtn = document.getElementById('moreQuestionsBtn');
        const confirmBtn = document.getElementById('confirmCompleteBtn');
        if (moreBtn) moreBtn.disabled = true;
        if (confirmBtn) confirmBtn.disabled = true;
        document.getElementById('submitStatus').textContent = '';
        try {
          const url =
            '/api/interviews/' +
            encodeURIComponent(interviewId) +
            '/nudge';
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            document.getElementById('submitStatus').textContent =
              err.error || 'Request failed.';
            if (moreBtn) moreBtn.disabled = false;
            if (confirmBtn) confirmBtn.disabled = false;
          } else {
            try { await refresh(); } catch (_) {}
            schedulePoll(); // Restart polling — nudge may reactivate interview
          }
        } catch (_err) {
          document.getElementById('submitStatus').textContent = 'Network error.';
          if (moreBtn) moreBtn.disabled = false;
          if (confirmBtn) confirmBtn.disabled = false;
        }
      }

      document.getElementById('moreQuestionsBtn').addEventListener('click', () => sendNudge('more-questions'));
      document.getElementById('confirmCompleteBtn').addEventListener('click', () => sendNudge('confirm-complete'));

      function schedulePoll() {
        setTimeout(async () => {
          try { await refresh(); } catch (_) {}
          // Stop polling for terminal states
          const terminalModes = ['abandoned', 'completed', 'session-disconnected'];
          if (!terminalModes.includes(state.data?.mode)) schedulePoll();
        }, 2500);
      }

      refresh().catch((error) => {
        document.getElementById('submitStatus').textContent = error.message || 'Failed to load interview.';
      });
      schedulePoll();
    </script>
  </body>
</html>`;
}
