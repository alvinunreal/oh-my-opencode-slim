# Playwright Browser Automation Skill

This skill provides browser automation capabilities via the Playwright MCP server.

**Capabilities**:
- Navigate to web pages
- Click elements and interact with UI
- Fill forms and submit data
- Take screenshots
- Extract content from pages
- Verify visual state
- Run automated tests

**Common Use Cases**:
- Verify frontend changes visually
- Test responsive design across viewports
- Capture screenshots for documentation
- Scrape web content
- Automate browser-based workflows

**Process**:
1. Load the skill to access MCP tools
2. Use playwright MCP tools for browser automation
3. Screenshots are saved to `/tmp/playwright-mcp-output/`
4. Report results with screenshot paths when relevant

**Example Workflow** (Frontend agent):
1. Make UI changes to component
2. Use playwright to open page
3. Take screenshot of before/after
4. Verify responsive behavior
5. Return results with visual proof
