import type { RemoteMcpConfig } from "./types";

/**
 * Exa AI web search - real-time web search
 * @see https://exa.ai
 */
export const websearch: RemoteMcpConfig = {
  type: "remote",
  url: "https://mcp.exa.ai/mcp?tools=web_search_exa",
  headers: process.env.EXA_API_KEY
    ? { "x-api-key": process.env.EXA_API_KEY }
    : undefined,
  oauth: false,
};
