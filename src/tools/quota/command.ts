import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { log } from "../../shared/logger";

// Define base configuration directory based on OS
const isWindows = os.platform() === "win32";
const configBase = isWindows
  ? path.join(os.homedir(), "AppData", "Roaming", "opencode")
  : path.join(os.homedir(), ".config", "opencode");

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

// Try to create the command file for OpenCode context
try {
  if (!fs.existsSync(commandDir)) {
    fs.mkdirSync(commandDir, { recursive: true });
  }
  if (!fs.existsSync(commandFile)) {
    fs.writeFileSync(commandFile, commandContent, "utf-8");
  } else {
    const currentContent = fs.readFileSync(commandFile, "utf-8");
    if (currentContent.includes("model: opencode/grok-code")) {
      fs.writeFileSync(commandFile, commandContent, "utf-8");
    }
  }
} catch (error) {
  log("Failed to create command file/directory:", error);
  // Continue execution, as this might not be fatal for the plugin's core function
}
