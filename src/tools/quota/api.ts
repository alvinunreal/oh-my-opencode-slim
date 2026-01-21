import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { sleep } from "../../utils/polling";
import type {
  Account,
  AccountsConfig,
  TokenResponse,
  LoadCodeAssistResponse,
  QuotaResponse,
  AccountQuotaResult,
  ModelQuota,
} from "./types";

// API endpoints
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLOUDCODE_BASE_URL = "https://cloudcode-pa.googleapis.com";

// Timing constants
const DEFAULT_RESET_MS = 86_400_000; // 24 hours - fallback when API doesn't provide reset time
const ACCOUNT_FETCH_DELAY_MS = 200; // Delay between account fetches to avoid rate limiting
const CLOUDCODE_METADATA = {
  ideType: "ANTIGRAVITY",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
};

// Client credentials (from opencode-antigravity-auth)
const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";

// Config paths
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

export function loadAccountsConfig(): AccountsConfig | null {
  for (const p of CONFIG_PATHS) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as AccountsConfig;
    }
  }
  return null;
}

async function refreshToken(refreshToken: string): Promise<string> {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) throw new Error(`Token refresh failed (${res.status})`);
  const data = (await res.json()) as TokenResponse;
  return data.access_token;
}

async function loadCodeAssist(accessToken: string): Promise<LoadCodeAssistResponse> {
  const res = await fetch(`${CLOUDCODE_BASE_URL}/v1internal:loadCodeAssist`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "antigravity",
    },
    body: JSON.stringify({ metadata: CLOUDCODE_METADATA }),
  });

  if (!res.ok) throw new Error(`loadCodeAssist failed (${res.status})`);
  return (await res.json()) as LoadCodeAssistResponse;
}

function extractProjectId(project: unknown): string | undefined {
  if (typeof project === "string" && project) return project;
  if (project && typeof project === "object" && "id" in project) {
    const id = (project as { id?: string }).id;
    if (id) return id;
  }
  return undefined;
}

async function fetchModels(accessToken: string, projectId?: string): Promise<QuotaResponse> {
  const payload = projectId ? { project: projectId } : {};
  const res = await fetch(`${CLOUDCODE_BASE_URL}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "antigravity",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`fetchModels failed (${res.status})`);
  return (await res.json()) as QuotaResponse;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

// Filter out internal/test models
const EXCLUDED_PATTERNS = ["chat_", "rev19", "gemini 2.5", "gemini 3 pro image"];

export async function fetchAccountQuota(account: Account): Promise<AccountQuotaResult> {
  try {
    const accessToken = await refreshToken(account.refreshToken);
    let projectId = account.projectId || account.managedProjectId;

    if (!projectId) {
      const codeAssist = await loadCodeAssist(accessToken);
      projectId = extractProjectId(codeAssist.cloudaicompanionProject);
    }

    const quotaRes = await fetchModels(accessToken, projectId);
    if (!quotaRes.models) {
      return { email: account.email, success: true, models: [] };
    }

    const now = Date.now();
    const models: ModelQuota[] = [];

    for (const [key, info] of Object.entries(quotaRes.models)) {
      const qi = info.quotaInfo;
      if (!qi) continue;

      const label = info.displayName || key;
      const lower = label.toLowerCase();
      if (EXCLUDED_PATTERNS.some((p) => lower.includes(p))) continue;

      const pct = Math.min(100, Math.max(0, (qi.remainingFraction ?? 0) * 100));
      let resetMs = DEFAULT_RESET_MS;
      if (qi.resetTime) {
        const parsed = new Date(qi.resetTime).getTime();
        if (!isNaN(parsed)) resetMs = Math.max(0, parsed - now);
      }

      models.push({
        name: label,
        percent: pct,
        resetIn: formatDuration(resetMs),
      });
    }

    // Sort by name
    models.sort((a, b) => a.name.localeCompare(b.name));
    return { email: account.email, success: true, models };
  } catch (err) {
    return {
      email: account.email,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      models: [],
    };
  }
}

export async function fetchAllQuotas(accounts: Account[]): Promise<AccountQuotaResult[]> {
  const results: AccountQuotaResult[] = [];
  for (let i = 0; i < accounts.length; i++) {
    if (i > 0) await sleep(ACCOUNT_FETCH_DELAY_MS);
    results.push(await fetchAccountQuota(accounts[i]));
  }
  return results;
}
