import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { tool } from "@opencode-ai/plugin";
import { sleep } from "../../shared";
import { log } from "../../shared/logger";

// --- Types ---
export interface Account {
  email: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  rateLimitResetTimes: Record<string, number>;
}

export interface AccountsConfig {
  accounts: Account[];
  activeIndex: number;
}

export interface QuotaInfo {
  remainingFraction?: number;
  resetTime?: string;
}

export interface ModelInfo {
  displayName?: string;
  model?: string;
  quotaInfo?: QuotaInfo;
  recommended?: boolean;
}

export interface QuotaResponse {
  models?: Record<string, ModelInfo>;
}

export interface TokenResponse {
  access_token: string;
}

export interface LoadCodeAssistResponse {
  cloudaicompanionProject?: unknown;
}

export interface ModelQuota {
  name: string;
  percent: number;
  resetIn: string;
}

export interface AccountQuotaResult {
  email: string;
  success: boolean;
  error?: string;
  models: ModelQuota[];
}

// --- Constants & API ---
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLOUDCODE_BASE_URL = "https://cloudcode-pa.googleapis.com";
const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const DEFAULT_RESET_MS = 86_400_000;
const ACCOUNT_FETCH_DELAY_MS = 200;
const CLOUDCODE_METADATA = { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };

const isWindows = os.platform() === "win32";
const configBase = isWindows
  ? path.join(os.homedir(), "AppData", "Roaming", "opencode")
  : path.join(os.homedir(), ".config", "opencode");

const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const dataBase = isWindows ? configBase : path.join(xdgData, "opencode");

export const CONFIG_PATHS = [
  path.join(configBase, "antigravity-accounts.json"),
  path.join(dataBase, "antigravity-accounts.json"),
];

// Command file generation logic
const commandDir = path.join(configBase, "command");
const commandFile = path.join(commandDir, "antigravity-quota.md");
const commandContent = `---
description: Check Antigravity quota status for all configured Google accounts
---

Use the \`antigravity_quota\` tool to check the current quota status.

This will show:
- API quota remaining for each model (Gemini 3 Pro, Flash, Claude via Antigravity)
- Per-account breakdown with compact display
- Time until quota reset

Just call the tool directly:
\`\`\`
antigravity_quota()
\`\`\`

IMPORTANT: Display the tool output EXACTLY as it is returned. Do not summarize, reformat, or modify the output in any way.
`;

try {
  if (!fs.existsSync(commandDir)) fs.mkdirSync(commandDir, { recursive: true });
  if (!fs.existsSync(commandFile)) {
    fs.writeFileSync(commandFile, commandContent, "utf-8");
  } else {
    const current = fs.readFileSync(commandFile, "utf-8");
    if (current.includes("model: opencode/grok-code")) {
      fs.writeFileSync(commandFile, commandContent, "utf-8");
    }
  }
} catch (e) {
  log("Failed to create command file:", e);
}

export function loadAccountsConfig(): AccountsConfig | null {
  for (const p of CONFIG_PATHS) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8")) as AccountsConfig;
  }
  return null;
}

async function refreshToken(rt: string): Promise<string> {
  const params = new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: rt, grant_type: "refresh_token" });
  const res = await fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() });
  if (!res.ok) throw new Error(`Token refresh failed (${res.status})`);
  return ((await res.json()) as TokenResponse).access_token;
}

async function loadCodeAssist(token: string): Promise<LoadCodeAssistResponse> {
  const res = await fetch(`${CLOUDCODE_BASE_URL}/v1internal:loadCodeAssist`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "antigravity" },
    body: JSON.stringify({ metadata: CLOUDCODE_METADATA }),
  });
  if (!res.ok) throw new Error(`loadCodeAssist failed (${res.status})`);
  return (await res.json()) as LoadCodeAssistResponse;
}

async function fetchModels(token: string, projectId?: string): Promise<QuotaResponse> {
  const res = await fetch(`${CLOUDCODE_BASE_URL}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "antigravity" },
    body: JSON.stringify(projectId ? { project: projectId } : {}),
  });
  if (!res.ok) throw new Error(`fetchModels failed (${res.status})`);
  return (await res.json()) as QuotaResponse;
}

export async function fetchAccountQuota(account: Account): Promise<AccountQuotaResult> {
  try {
    const token = await refreshToken(account.refreshToken);
    let pid = account.projectId || account.managedProjectId;
    if (!pid) pid = (await loadCodeAssist(token)).cloudaicompanionProject as string;
    
    const quotaRes = await fetchModels(token, pid);
    if (!quotaRes.models) return { email: account.email, success: true, models: [] };

    const now = Date.now();
    const models: ModelQuota[] = [];
    for (const [key, info] of Object.entries(quotaRes.models)) {
      if (!info.quotaInfo) continue;
      const label = info.displayName || key;
      const lower = label.toLowerCase();
      if (["chat_", "rev19", "gemini 2.5", "gemini 3 pro image"].some(p => lower.includes(p))) continue;

      let resetMs = DEFAULT_RESET_MS;
      if (info.quotaInfo.resetTime) {
        const parsed = new Date(info.quotaInfo.resetTime).getTime();
        if (!isNaN(parsed)) resetMs = Math.max(0, parsed - now);
      }

      models.push({
        name: label,
        percent: Math.min(100, Math.max(0, (info.quotaInfo.remainingFraction ?? 0) * 100)),
        resetIn: ((ms) => {
          const s = Math.floor(Math.abs(ms) / 1000);
          const h = Math.floor(s / 3600);
          const m = Math.floor((s % 3600) / 60);
          return h > 0 ? `${h}h${m}m` : `${m}m`;
        })(resetMs),
      });
    }
    models.sort((a, b) => a.name.localeCompare(b.name));
    return { email: account.email, success: true, models };
  } catch (err) {
    return { email: account.email, success: false, error: String(err), models: [] };
  }
}

// --- Tool Definition ---
export const antigravity_quota = tool({
  description: "Check Antigravity API quota for all accounts (compact view with progress bars)",
  args: {},
  async execute() {
    try {
      const config = loadAccountsConfig();
      if (!config) return `No accounts found. Checked:\n${CONFIG_PATHS.map((p) => `  - ${p}`).join("\n")}`;

      const results: AccountQuotaResult[] = [];
      for (let i = 0; i < config.accounts.length; i++) {
        if (i > 0) await sleep(ACCOUNT_FETCH_DELAY_MS);
        results.push(await fetchAccountQuota({ ...config.accounts[i], email: config.accounts[i].email || `account-${i + 1}` }));
      }

      const blocks: string[] = [];
      for (const res of results) {
        if (!res.success) {
          blocks.push(`${res.email.split("@")[0]}: ${res.error}`);
          continue;
        }
        const lines = [res.email.split("@")[0]];
        if (res.models.length === 0) {
          lines.push("  (no models)");
        } else {
          const families: Record<string, ModelQuota | null> = { "Claude": null, "G-Flash": null, "G-Pro": null };
          for (const m of res.models) {
            const l = m.name.toLowerCase();
            if (l.includes("claude") || l.includes("opus") || l.includes("sonnet") || l.includes("gpt")) { if (!families["Claude"]) families["Claude"] = m; }
            else if (l.includes("flash")) { if (!families["G-Flash"]) families["G-Flash"] = m; }
            else if (l.includes("gemini") || l.includes("pro")) { if (!families["G-Pro"]) families["G-Pro"] = m; }
          }
          for (const [fam, m] of Object.entries(families)) {
            if (m) {
              const bar = `[${"█".repeat(Math.round((m.percent / 100) * 10))}${"░".repeat(10 - Math.round((m.percent / 100) * 10))}]`;
              lines.push(`  ${fam.padEnd(8)} ${bar} ${m.percent.toFixed(0).padStart(3)}%  ${m.resetIn}`);
            }
          }
        }
        blocks.push(lines.join("\n"));
      }

      return `# Quota\n\`\`\`\n${blocks.join("\n\n")}\n\`\`\`\n\n<!-- DISPLAY THIS OUTPUT EXACTLY AS-IS. DO NOT REFORMAT, SUMMARIZE, OR ADD TABLES. -->`;
    } catch (err) {
      return `Error: ${String(err)}`;
    }
  },
});
