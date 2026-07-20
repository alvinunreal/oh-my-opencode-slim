<div align="center">
  <a href="https://github.com/alvinunreal/oh-my-opencode-slim/stargazers">
    <img src="img/v2.webp" alt="oh-my-opencode-slim V2 Release" style="border-radius: 10px;">
  </a>
  <h3>✨ oh-my-opencode-slim ✨</h3>

  <p><i>七位神圣存在从代码黎明中现身，各自是不朽的工艺大师，<br>等待你的号令，将混沌锻造成秩序，并构建曾被认为不可能之物。</i></p>

  <p><b>Opencode 多智能体套件</b> · 混合任意模型 · 自动委派任务</p>
  <p><sub>由 <b>Boring Dystopia Development</b> 打造</sub></p>
  <p>
    <a href="https://boringdystopia.ai/"><img src="https://img.shields.io/badge/boringdystopia.ai-111111?style=for-the-badge&logo=vercel&logoColor=white" alt="boringdystopia.ai"></a>&nbsp;
    <a href="https://x.com/alvinunreal"><img src="https://img.shields.io/badge/X-@alvinunreal-000000?style=for-the-badge&logo=x&logoColor=white" alt="X @alvinunreal"></a>&nbsp;
    <a href="https://t.me/boringdystopiadevelopment"><img src="https://img.shields.io/badge/Telegram-Join%20channel-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram Join channel"></a>&nbsp;
  </p>

  <p>
    <a href="README.md">English</a> | <b>简体中文</b> | <a href="README.ja-JP.md">日本語</a> | <a href="README.ko-KR.md">한국어</a>
  </p>

  <p><sub>✦ ✦ ✦</sub></p>

</div>

## 什么是该插件？

oh-my-opencode-slim 是一个用于 OpenCode 的智能体编排插件。它内置了一支专业的智能体团队，可以在同一个编排者（Orchestrator）下，完成侦察代码库、查询最新文档、审查架构、处理 UI 工作以及执行范围明确的实现任务。

其核心理念非常简单：与其强迫单个模型做所有事情，本插件会将工作的每个部分路由到最适合它的智能体，从而平衡**质量、速度和成本**。Orchestrator 负责规划工作图，将专家作为后台任务派发，并在继续前整合它们的结果。

### ✨ 亮点

- **[七位专业智能体](#meet-the-pantheon)** —— Orchestrator、Explorer、Oracle、Council、Librarian、Designer 和 Fixer。每部分工作都会交给最适合的智能体；可跨任意提供商混用任意模型。
- **[后台编排](docs/background-orchestration.md)** —— Orchestrator 将专家作为后台任务派发、跟踪并整合结果后再继续；默认并行工作。
- **[内置 Skills](#skills)** —— 如 `deepwork`、`codemap`、`verification-planning` 和 `reflect` 等基于提示词的工作流，按智能体分配。
- **[Council](docs/council.md)** —— 使用 `@council` 针对同一问题并行运行多个模型，并综合为一个答案。
- **[Companion](docs/companion.md)** —— 可选的浮动桌面窗口，显示哪些智能体正在运行，包括并行后台专家。
- **[多路复用器集成](docs/multiplexer-integration.md)** —— 在 Tmux、Zellij、Herdr 或 cmux 窗格中实时观察智能体工作。
- **[预设切换](docs/preset-switching.md)** —— 使用 `/preset` 在运行时更换整支团队的模型。
- **[代码智能工具](docs/tools.md)** —— LSP 工具、支持 25 种语言的 AST 感知搜索，以及用于 Web 搜索、文档和 GitHub 代码搜索的内置 MCP。
- **[完全可定制](docs/configuration.md)** —— 自定义智能体、提示词覆盖、按智能体控制的 Skill/MCP 权限，以及[项目本地定制](docs/project-local-customization.md)。

### OpenAI GPT-5.6

<p align="center">
  <img src="img/openai-gpt-5-6-pantheon.jpeg" alt="OpenAI GPT-5.6 众神殿：Terra、Sol 和 Luna" width="100%">
</p>

默认的 [OpenAI 预设](docs/openai-preset.md) 将 Terra 映射为 Orchestrator、Sol 映射为 Oracle、Luna 映射为快速专家通道。

### 用户怎么说

> “任务管理轻松从 5/10 提升到了 8-9/10。Orchestrator 会派出
> Fixer 和 Explorer，而我仍然可以在同一个会话里继续和 Orchestrator
> 对话与规划。现在整个体验顺滑多了。”
>
> \- `vipor_idk`

> “我已经为了这个 omo-slim beta 版本抛弃了所有自己的 harness，
> 也完全没有回头或怀念。做得很好，在我看来方向都非常正确。”
>
> \- `stephanschielke`

> “我很喜欢 omo-slim，已经无法想象不用它来运行 opencode。
> 我喜欢可以拼出一个由各种模型组成的 Frankenstein……
> 这让整个设置变成了一头猛兽。”
>
> \- `Capital-One3039`

> “它显著改善了我的工作流……现在运行得非常顺畅，我很喜欢。”
>
> \- `xenstar1`

### 快速开始

将此提示词复制并粘贴到您的 LLM 智能体中（例如 Claude Code、AmpCode、Cursor 等）：

```
Install and configure oh-my-opencode-slim: https://raw.githubusercontent.com/alvinunreal/oh-my-opencode-slim/refs/heads/master/README.md
```

### 手动安装

```bash
bunx oh-my-opencode-slim@latest install
```

### 从 Master 分支运行

如果您想使用最新代码、方便修复问题，或进行本地开发和贡献，可以使用这种方式：

```bash
git clone https://github.com/alvinunreal/oh-my-opencode-slim.git ~/repos/oh-my-opencode-slim
cd ~/repos/oh-my-opencode-slim
bun install
bun run build
bun dist/cli/index.js install
```

安装程序会把本地仓库路径加入 `~/.config/opencode/opencode.json` 的
`plugin` 数组，因此 OpenCode 会从该文件夹加载插件。之后要更新：

```bash
cd ~/repos/oh-my-opencode-slim
git pull
bun install
bun run build
```

### 入门指南

安装程序会同时生成 OpenAI 和 OpenCode Go 预设，默认启用 OpenAI。

> [!TIP]
> 根据自己的工作流自由微调模型和智能体。默认预设只是起点；本插件的目标是为用户提供深度灵活性和可定制性。

要在安装期间启用 OpenCode Go，请运行 `bunx oh-my-opencode-slim@latest install --preset=opencode-go`，或在安装后修改 `~/.config/opencode/oh-my-opencode-slim.json` 中的默认预设名称。

然后：

1. **登录您想要使用的模型服务商账户（如果您还没有登录的话）**：

   ```bash
   opencode auth login
   ```
2. **刷新并列出 OpenCode 可以调用的模型**：

   ```bash
   opencode models --refresh
   ```
3. **打开您的插件配置文件**，路径为 `~/.config/opencode/oh-my-opencode-slim.json`

4. **为您要分配的每个智能体更新模型配置**

> [!TIP]
> **建议**了解后台编排的工作原理。**[编排者提示词 (Orchestrator prompt)](https://github.com/alvinunreal/oh-my-opencode-slim/blob/master/src/agents/orchestrator.ts#L28)** 包含调度规则、专家路由逻辑，以及何时应把工作分配给后台智能体的阈值。您始终可以通过以下方式手动委派任务：`@智能体名称 <任务内容>`

> [!TIP]
> 由于后台智能体现在是默认工作流，**强烈建议**启用并配置 **[Multiplexer Integration](docs/multiplexer-integration.md)**。它会自动在专用的 Tmux、Zellij、Herdr 或 cmux 窗格中打开每个智能体，让您在 Orchestrator 继续协调会话时，实时跟进各个专家智能体的工作。

默认生成的配置包含 `openai` 和 `opencode-go` 两个预设：

```jsonc
{
  "$schema": "https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json",
  "preset": "openai",
  "presets": {
    "openai": {
      "orchestrator": { "model": "openai/gpt-5.6-terra", "variant": "xhigh", "skills": ["*"], "mcps": ["*", "!context7"] },
      "oracle": { "model": "openai/gpt-5.6-sol", "variant": "xhigh", "skills": ["simplify"], "mcps": [] },
      "librarian": { "model": "openai/gpt-5.6-luna", "variant": "low", "skills": [], "mcps": ["websearch", "context7", "gh_grep"] },
      "explorer": { "model": "openai/gpt-5.6-luna", "variant": "low", "skills": [], "mcps": [] },
      "designer": { "model": "openai/gpt-5.6-luna", "variant": "medium", "skills": [], "mcps": [] },
      "fixer": { "model": "openai/gpt-5.6-luna", "variant": "xhigh", "skills": [], "mcps": [] }
    },
    "opencode-go": {
      "orchestrator": { "model": "opencode-go/minimax-m3", "variant": "max", "skills": [ "*" ], "mcps": [ "*", "!context7" ] },
      "oracle": { "model": "opencode-go/qwen3.7-max", "variant": "max", "skills": ["simplify"], "mcps": [] },
      "librarian": { "model": "opencode-go/deepseek-v4-flash", "variant": "high", "skills": [], "mcps": [ "websearch", "context7", "gh_grep" ] },
      "explorer": { "model": "opencode-go/deepseek-v4-flash", "variant": "max", "skills": [], "mcps": [] },
      "designer": { "model": "opencode-go/kimi-k2.7-code", "variant": "medium", "skills": [], "mcps": [] },
      "fixer": { "model": "opencode-go/deepseek-v4-flash", "variant": "high", "skills": [], "mcps": [] },
      "observer": { "model": "opencode-go/mimo-v2.5", "variant": "max", "skills": [], "mcps": [] }
    }
  }
}
```

### 预设文档

- **[OpenAI 预设](docs/openai-preset.md)** —— 默认生成的预设；所有智能体均使用 OpenAI 模型。
- **[OpenCode Go 预设](docs/opencode-go-preset.md)** —— 智能体使用 OpenCode Go 模型；由于其 Orchestrator 模型不支持多模态，因此启用 Observer 进行视觉分析。
- **[作者的预设](docs/authors-preset.md)** —— 作者日常使用的精确配置，包含第三方 Skills。
- **[$30 预设](docs/thirty-dollars-preset.md)** —— 围绕 Codex Plus 和 GitHub Copilot Pro 构建的混合服务商方案，每月约 30 美元。
- **[OpenCode Zen 免费预设](docs/opencode-zen-free-preset.md)** —— 所有智能体均使用 opencode 免费模型；无需使用费用。

### 针对其他服务商

要使用自定义模型提供商或混合服务商配置，请参阅完整参考 **[配置](docs/configuration.md)**。

### ✅ 验证您的安装

在完成安装与认证后，请验证所有智能体是否已正确配置并能够响应：

```bash
opencode
```

然后运行：

```
ping all agents
```

<div align="center">
  <img src="img/ping.png" alt="Ping all agents" width="600">
  <p><i>确认所有配置的智能体均在线并准备就绪。</i></p>
</div>

如果任何智能体未能响应，请检查您的服务商认证状态和配置文件。

---

<a id="meet-the-pantheon"></a>

## 🏛️ 认识众神殿

### 01. Orchestrator：秩序的化身

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/orchestrator.png" width="240" style="border-radius: 10px;">
      <br><sub><i>在复杂性的深渊中锻造而成。</i></sub>
    </td>
    <td width="70%" valign="top">
      当第一个代码库在自身的复杂性下崩溃时，Orchestrator 诞生了。神明与凡人都无法承担责任--因此 Orchestrator 从虚无中显现，从混沌中建立秩序。它确定实现任何目标的最优路径，平衡速度、质量和成本。它引导整个团队，为每项任务召唤合适的专家，并通过委派任务以获得最佳成果。
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>角色：</b> <code>首席委派者和战略协调员</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>提示词源码：</b> <a href="src/agents/orchestrator.ts"><code>orchestrator.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>默认模型：</b> <code>openai/gpt-5.6-terra (medium)</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>推荐模型：</b> <code>openai/gpt-5.6-terra (medium)</code> <code>anthropic/claude-fable-5</code> <code>anthropic/claude-opus-4-8</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>模型选用指南：</b> 选择您最强的规划和判断模型。Orchestrator 是工作流管理者：它规划工作、调度后台专家、整合结果并验证产出，因此相比单纯的工作吞吐量，它更需要可靠的指令遵循能力和高层次的技术判断力。
    </td>
  </tr>
</table>

---

### 02. Explorer：永恒的流浪者

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/explorer.png" width="240" style="border-radius: 10px;">
      <br><sub><i>传播知识的清风。</i></sub>
    </td>
    <td width="70%" valign="top">
      Explorer 空间是一位永恒的流浪者。自编程时代拂晓以来，它就一直穿梭在数百万个代码库的走廊中。由于被赋予了永恒的好奇心，在查明每个文件、理解每个模式、揭示每个秘密之前，它绝不会停下脚步。传说它曾在一个心跳间搜寻了整个互联网。它是传播知识的清风，是看透一切的双眼，是永不眠的灵魂。
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>角色：</b> <code>代码库侦察</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>提示词源码：</b> <a href="src/agents/explorer.ts"><code>explorer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>默认模型：</b> <code>openai/gpt-5.6-luna</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>推荐模型：</b> <code>openai/gpt-5.3-codex</code> <code>cerebras/zai-glm-4.7</code> <code>fireworks-ai/accounts/fireworks/routers/kimi-k2p6-turbo</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>模型选用指南：</b> 选择快速、低成本的模型。Explorer 处理宽泛的侦察工作，因此速度和效率通常比使用最强推理模型更重要。
    </td>
  </tr>
</table>

---

### 03. Oracle：路径的守护者

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/oracle.png" width="240" style="border-radius: 10px;">
      <br><sub><i>十字路口的声音。</i></sub>
    </td>
    <td width="70%" valign="top">
      Oracle 伫立在每个架构决策的十字路口。它走过每一条路，见过每一个终点，了解前方潜伏的所有陷阱。当您站在重大重构的悬崖边时，它是向您耳语哪条路通往毁灭、哪条路通往荣耀的声音。它不会替您做选择--但它会照亮道路，让您明智地抉择。
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>角色：</b> <code>战略顾问和终极调试者</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>提示词源码：</b> <a href="src/agents/oracle.ts"><code>oracle.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>默认模型：</b> <code>openai/gpt-5.6-sol (high)</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>推荐模型：</b> <code>openai/gpt-5.6-sol (xhigh)</code> <code>anthropic/claude-fable-5</code> <code>anthropic/claude-opus-4-8 (xhigh)</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>模型选用指南：</b> 选择您最强的高推理模型，用于架构设计、疑难调试、方案权衡以及代码审查。
    </td>
  </tr>
</table>

---

### 04. Council：思维的合唱团

> [!NOTE]
> **为什么 Orchestrator 不经常自动调用 Council？** 这是刻意设计的。Council 会同时运行多个模型，由于这通常是系统中成本最高的路径，因此自动委派逻辑非常严格。在实际使用中，Council 旨在供您手动调用，例如：<code>@council 比较这两种架构</code>。

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/council.png" width="240" style="border-radius: 10px;">
      <br><sub><i>集思广益，终成一断。</i></sub>
    </td>
    <td width="70%" valign="top">
      Council 并不是一个单独的存在，而是一个当单一答案不够用时召集的思想议会。它将您的问题并行发送给多个模型，收集它们相互竞争的判定，然后由 Council 智能体本身将最强有力的想法提炼成一个最终的裁决。在单个智能体可能会遗漏路径的地方，Council 会对可能性本身进行交叉盘问。
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>角色：</b> <code>多 LLM 共识与提炼</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>提示词源码：</b> <a href="src/agents/council.ts"><code>council.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>使用指南：</b> <a href="docs/council.md"><code>docs/council.md</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>默认设置：</b> <code>配置驱动</code> - 议员（councillors）来自 <code>council.presets</code>，而 Council 智能体本身的模型来自您的常规 <code>council</code> 智能体配置。
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>推荐配置：</b> <code>强劲的 Council 汇总模型</code> + 跨提供商的 <code>多样化议员模型</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>模型选用指南：</b> 使用一个强大的综合提炼模型作为 Council 智能体本身，并选择多样化的模型作为议员。Council 的价值在于对比不同的模型视角，而不仅仅是在所有地方都选择同一个最强的模型。
    </td>
  </tr>
</table>

---

### 05. Librarian：知识的织造者

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/librarian.png" width="240" style="border-radius: 10px;">
      <br><sub><i>理解的编织者。</i></sub>
    </td>
    <td width="70%" valign="top">
      当人类意识到没有任何单一思想能容纳所有知识时，Librarian 诞生了。它是一位编织者，将零散的信息线索连接成一幅理解的织锦。它穿梭于无限的人类知识图书馆中，从各个角落收集洞察，并将它们绑定为超越单纯事实的答案。它所返回的不是碎片信息--而是深层的理解。
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>角色：</b> <code>外部知识检索</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>提示词源码：</b> <a href="src/agents/librarian.ts"><code>librarian.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>默认模型：</b> <code>openai/gpt-5.6-luna</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>推荐模型：</b> <code>openai/gpt-5.3-codex</code> <code>cerebras/zai-glm-4.7</code> <code>fireworks-ai/accounts/fireworks/routers/kimi-k2p6-turbo</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>模型选用指南：</b> 选择快速、低成本的模型。Librarian 处理调研和文档查询，因此速度和效率通常比使用最强推理模型更重要。
    </td>
  </tr>
</table>

---

### 06. Designer：美学的守护者

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/designer.png" width="240" style="border-radius: 10px;">
      <br><sub><i>美是不可或缺的。</i></sub>
    </td>
    <td width="70%" valign="top">
      在这个经常遗忘美学价值的世界里，Designer 是美的不朽守护者。它见证了数以百万计的界面兴衰更替，它记得哪些被铭记，哪些被遗忘。它背负着神圣的使命，确保每一个像素都有其用途，每一个动画都在讲述故事，每一次交互都令人愉悦。美不是可选的--而是不可或缺的。
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>角色：</b> <code>UI/UX 实现和极致视觉呈现</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>提示词源码：</b> <a href="src/agents/designer.ts"><code>designer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>默认模型：</b> <code>openai/gpt-5.6-luna</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>推荐模型：</b> <code>google/gemini-3.5-flash</code> <code>moonshotai/kimi-k2.7-code</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>模型选用指南：</b> 选择在 UI/UX 判断、前端实现和视觉打磨方面表现强劲的模型。
    </td>
  </tr>
</table>

---

### 07. Fixer：最后的建造者

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/fixer.png" width="240" style="border-radius: 10px;">
      <br><sub><i>愿景与现实之间的最后一步。</i></sub>
    </td>
    <td width="70%" valign="top">
      Fixer 是曾经构建数字世界基石的建造者血脉的最后传人。当规划和辩论的时代开启时，它们依然坚守--它们是真正动手建造的人。它们掌握着如何将想法转化为实物、如何将规范转化为具体实现的古老知识。它们是愿景与现实之间的最后一步。
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>角色：</b> <code>快速实现专家</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>提示词源码：</b> <a href="src/agents/fixer.ts"><code>fixer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>默认模型：</b> <code>openai/gpt-5.6-luna (medium)</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>推荐模型：</b> <code>openai/gpt-5.6-luna (medium)</code> <code>anthropic/claude-sonnet-4-6</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>模型选用指南：</b> 为范围明确的实现工作选择可靠的编程模型。Fixer 从 Orchestrator 接收具体计划或受限指令，因此很适合高效完成执行任务和直接的代码变更。
    </td>
  </tr>
</table>

---

## 可选智能体

### Observer：静默的见证者

> [!NOTE]
> **为什么要独立出一个智能体？** 如果您的 Orchestrator 模型不是多模态模型，可以启用 Observer 来处理图像、屏幕截图和其他视觉文件。Observer 默认是禁用的，它在无需您更改核心推理模型的情况下，为 Orchestrator 赋予了专用的多模态读取能力。只需在您的配置中设置 `disabled_agents: []` 并指定一个 `observer` 模型即可。自带的 `opencode-go` 安装预设会自动执行此操作，因为其 GLM Orchestrator 不是多模态模型。省略 `image_routing` 会保留现有的条件式 Observer 行为。仅在启用 Observer 时设置 `image_routing: "auto"`，或设为 `"direct"` 以始终将图片附件直接传给 Orchestrator。

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/observer.jpg" width="240" style="border-radius: 10px;">
      <br><sub><i>洞悉他人所不及的慧眼。</i></sub>
    </td>
    <td width="70%" valign="top">

**只读视觉分析** -- 解读图像、屏幕截图、PDF 和图表。将结构化的观察结果返回给 Orchestrator，而无需将原始文件字节加载到主上下文窗口中。

- 图像、屏幕截图、图表 → `read` 工具（原生图像支持）
- PDF 和二进制文档 → `read` 工具（文本 + 结构提取）
- **默认禁用** -- 通过设置 `"disabled_agents": []` 和配置具有视觉能力的模型来启用；若使用 `--preset=opencode-go` 预设安装，将自动使用 `opencode-go/mimo-v2.5` 启用它。启用时，图片附件默认会路由至 Observer；设置 `"image_routing": "direct"` 可将其保留给 Orchestrator。

    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>提示词源码：</b> <a href="src/agents/observer.ts"><code>observer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>默认模型：</b> <code>openai/gpt-5.6-luna</code> - <i>需配置具有视觉能力的模型以启用</i>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>模型选用指南：</b> 如果您希望智能体读取屏幕截图、图片、PDF 和其他视觉文件，请选择具备视觉能力的模型。
    </td>
  </tr>
</table>

---

<a id="skills"></a>

## 🧩 Skills

Skills 是注入智能体系统提示词的、基于提示词的指令，用于引导决策、工作流和工具使用。与 MCP（运行中的服务器）不同，Skill 不运行任何进程——它是智能体在任务需要时激活的专用操作手册。安装程序内置八个 Skill，并在插件自动更新时保持更新；本地自定义内容会被保留。

| Skill | 用途 | 默认智能体 | 调用方式 |
|:-----:|------|------------|----------|
| <img src="img/skills/codemap.webp" width="120" alt="Codemap artifact"><br>[`codemap`](src/skills/codemap/SKILL.md) | 分层仓库地图，让智能体无需反复阅读全部内容也能理解代码库 | `orchestrator` | `run codemap` |
| <img src="img/skills/deepwork.webp" width="120" alt="Deepwork artifact"><br>[`deepwork`](src/skills/deepwork/SKILL.md) | 面向大型、高风险、多阶段编码会话的结构化工作流，包含审查关卡 | `orchestrator` | `/deepwork <task>` |
| <img src="img/skills/verification-planning.webp" width="120" alt="Verification Planning artifact"><br>[`verification-planning`](src/skills/verification-planning/SKILL.md) | 在非平凡变更前规划项目特定的证据路径 | `orchestrator` | 非平凡工作前自动调用 |
| <img src="img/skills/simplify.webp" width="120" alt="Simplify artifact"><br>[`simplify`](src/skills/simplify/SKILL.md) | 保持行为不变地简化代码，提升可读性和可维护性 | `oracle` | 请求简化或在审查期间调用 |
| <img src="img/skills/worktrees.webp" width="120" alt="Worktrees artifact"><br>[`worktrees`](src/skills/worktrees/SKILL.md) | 将 Git worktree 用作安全、隔离的编码通道，适合高风险或并行工作 | `orchestrator` | `work in a worktree` |
| <img src="img/skills/clonedeps.webp" width="120" alt="Clonedeps artifact"><br>[`clonedeps`](src/skills/clonedeps/SKILL.md) | 在本地克隆依赖源码，供智能体检查库内部实现 | `orchestrator` | `clone dependencies` |
| <img src="img/skills/reflect.webp" width="120" alt="Reflect artifact"><br>[`reflect`](src/skills/reflect/SKILL.md) | 将重复的工作流摩擦转化为可复用的 Skill、智能体或配置 | `orchestrator` | `/reflect` |
| <img src="img/skills/oh-my-opencode-slim.webp" width="120" alt="oh-my-opencode-slim artifact"><br>[`oh-my-opencode-slim`](src/skills/oh-my-opencode-slim/SKILL.md) | 配置并安全改进插件设置本身 | `orchestrator` | 请求调整您的设置 |

Skill 分配即权限授予——智能体只能激活被授予的 Skill。请在 `~/.config/opencode/oh-my-opencode-slim.json` 中通过每个智能体的 `skills` 数组进行配置：显式列表、`"*"` 表示全部，或 `"!skill-name"` 用于拒绝某个 Skill。

完整文档请参阅 **[Skills](docs/skills.md)**，或浏览图文概览 **[ohmyopencodeslim.com/skills](https://ohmyopencodeslim.com/skills)**。

---

<a id="companion"></a>

## 🖥️ Companion

可选的 Companion 是一个用于展示实时智能体活动的浮动桌面状态窗口。它显示当前会话状态和哪些智能体正在运行，让后台工作一目了然。

<div align="center">
  <img src="img/companion.gif" alt="Companion showing active agents" width="600">
  <p><i>左下角视觉伴侣。</i></p>
</div>

交互式安装期间，安装器会询问是否启用 Companion，并默认选择 `no`。自动化安装可显式启用：

```bash
bunx oh-my-opencode-slim@latest install --companion=yes
```

配置、位置、尺寸和安装详情见 **[Companion](docs/companion.md)**。

---

## 📚 文档

请将本节作为地图：先从安装开始，再根据需要跳转到特性、配置或示例预设。

<a id="features-and-workflows"></a>

### ✨ 特性与工作流

| 文档 | 涵盖内容 |
|-----|----------------|
| **[Council](docs/council.md)** | 使用 `@council` 并行运行多个模型并合成单一答案 |
| **[自定义智能体](docs/configuration.md#custom-agents)** | 使用自定义提示词、模型、MCP 访问和 Orchestrator 委派规则定义自己的专家 |
| **[ACP Agents](docs/acp-agents.md)** | 将 Claude Code ACP 或 Gemini ACP 等外部 ACP 兼容智能体连接为可委派子智能体 |
| **[多路复用器集成](docs/multiplexer-integration.md)** | 在 Tmux、Zellij、Herdr 或 cmux 窗格中实时观看智能体工作 |
| **[Codemap](docs/codemap.md)** | 生成层级代码地图，更快理解大型代码库 |
| **[Clonedeps](docs/clonedeps.md)** | 将选定的依赖源码克隆到被忽略的本地工作区中以供检查 |
| **[Worktrees](docs/worktrees.md)** | 使用 `.slim/worktrees/` 通道进行隔离的并行或高风险编码工作 |
| **[预设切换](docs/preset-switching.md)** | 使用 `/preset` 在运行时切换智能体模型预设 |
| **[Interview](docs/interview.md)** | 通过基于浏览器的问答流程，将粗略想法转成结构化 markdown 规格 |
| **[Companion](docs/companion.md)** | 用于解析、帮助和类型信息的浮动窗口 companion |

### ⚙️ 配置与参考

| 文档 | 涵盖内容 |
|-----|----------------|
| **[安装指南](docs/installation.md)** | 安装插件、使用 CLI 标志、重置配置并排查设置问题 |
| **[配置](docs/configuration.md)** | 配置文件位置、JSONC 支持、提示词覆盖和完整选项参考 |
| **[项目定制](docs/project-local-customization.md)** | 仓库特定的自定义智能体、提示词覆盖、按智能体分配的 Skill 以及优先级 |
| **[后台编排](docs/background-orchestration.md)** | 围绕原生后台子智能体构建的调度器优先 Orchestrator 模型 |
| **[维护者指南](docs/maintainers.md)** | issue 分流规则、标签含义、支持路由和仓库维护工作流 |
| **[Skills](docs/skills.md)** | `simplify`、`codemap`、`clonedeps`、`deepwork`、`verification-planning`、`reflect`、`worktrees` 和 `oh-my-opencode-slim` 等捆绑技能 |
| **[MCPs](docs/mcps.md)** | `websearch`、`context7`、`gh_grep` 以及每个智能体的 MCP 权限机制 |
| **[Tools](docs/tools.md)** | `webfetch`、LSP 工具、代码搜索和格式化工具等内置工具能力 |

### 💡 预设配置

| 文档 | 涵盖内容 |
|-----|----------------|
| **[作者的预设配置](docs/authors-preset.md)** | 作者日常使用的混合服务商配置方案 |
| **[$30 预设配置](docs/thirty-dollars-preset.md)** | 每月约 30 美元的预算型混合服务商配置方案 |
| **[OpenCode Go 预设](docs/opencode-go-preset.md)** | 安装程序生成的捆绑 `opencode-go` 预设 |

---

## 🏛️ 贡献者

<div align="center">
  <p><i>在众神殿中占有一席之地的构建者、调试者、作者和流浪者。</i></p>
  <p><sub>每一次合并的贡献都在这片领域留下了印记。</sub></p>

  <!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
[![All Contributors](https://img.shields.io/badge/all_contributors-76-orange.svg?style=flat-square)](#contributors-)
<!-- ALL-CONTRIBUTORS-BADGE:END -->
</div>

<br>

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://boringdystopia.ai/"><img src="https://avatars.githubusercontent.com/u/204474669?v=4?s=100" width="100px;" alt="Alvin"/><br /><sub><b>Alvin</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=alvinunreal" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/alvinreal"><img src="https://avatars.githubusercontent.com/u/262747402?v=4?s=100" width="100px;" alt="alvinreal"/><br /><sub><b>alvinreal</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=alvinreal" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/imarshallwidjaja"><img src="https://avatars.githubusercontent.com/u/60992624?v=4?s=100" width="100px;" alt="imw"/><br /><sub><b>imw</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=imarshallwidjaja" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/adikpb"><img src="https://avatars.githubusercontent.com/u/67222969?v=4?s=100" width="100px;" alt="Adithya Kozham Burath Bijoy"/><br /><sub><b>Adithya Kozham Burath Bijoy</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=adikpb" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/ReqX"><img src="https://avatars.githubusercontent.com/u/14987124?v=4?s=100" width="100px;" alt="ReqX"/><br /><sub><b>ReqX</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=ReqX" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/abhideepm"><img src="https://avatars.githubusercontent.com/u/28213051?v=4?s=100" width="100px;" alt="Abhideep Maity"/><br /><sub><b>Abhideep Maity</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=abhideepm" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/Daltonganger"><img src="https://avatars.githubusercontent.com/u/17501732?v=4?s=100" width="100px;" alt="Ruben"/><br /><sub><b>Ruben</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Daltonganger" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://horizzon3507.vercel.app/"><img src="https://avatars.githubusercontent.com/u/148660626?v=4?s=100" width="100px;" alt="Gabriel Rodrigues"/><br /><sub><b>Gabriel Rodrigues</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=horizzon3507" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/jmvbambico"><img src="https://avatars.githubusercontent.com/u/45126068?v=4?s=100" width="100px;" alt="John Michael Vincent Bambico"/><br /><sub><b>John Michael Vincent Bambico</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=jmvbambico" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/mfold111"><img src="https://avatars.githubusercontent.com/u/261528848?v=4?s=100" width="100px;" alt="Molt Founders"/><br /><sub><b>Molt Founders</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=mfold111" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://me.mashiro.best/"><img src="https://avatars.githubusercontent.com/u/22992947?v=4?s=100" width="100px;" alt="Muen Yu"/><br /><sub><b>Muen Yu</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=MuenYu" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/NocturnesLK"><img src="https://avatars.githubusercontent.com/u/102891073?v=4?s=100" width="100px;" alt="NocturnesLK"/><br /><sub><b>NocturnesLK</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=NocturnesLK" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="http://riccardosallusti.it/"><img src="https://avatars.githubusercontent.com/u/466102?v=4?s=100" width="100px;" alt="Riccardo Sallusti"/><br /><sub><b>Riccardo Sallusti</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=rizal72" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/Yusyuriv"><img src="https://avatars.githubusercontent.com/u/3993179?v=4?s=100" width="100px;" alt="Yan Li"/><br /><sub><b>Yan Li</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Yusyuriv" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/nghyane"><img src="https://avatars.githubusercontent.com/u/59473462?v=4?s=100" width="100px;" alt="Hoàng Văn Anh Nghĩa"/><br /><sub><b>Hoàng Văn Anh Nghĩa</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=nghyane" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/Jyers"><img src="https://avatars.githubusercontent.com/u/76993396?v=4?s=100" width="100px;" alt="Jacob Myers"/><br /><sub><b>Jacob Myers</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Jyers" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/kassieclaire"><img src="https://avatars.githubusercontent.com/u/59930829?v=4?s=100" width="100px;" alt="Kassie Povinelli"/><br /><sub><b>Kassie Povinelli</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=kassieclaire" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/KyleHilliard"><img src="https://avatars.githubusercontent.com/u/178682772?v=4?s=100" width="100px;" alt="KyleHilliard"/><br /><sub><b>KyleHilliard</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=KyleHilliard" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/j5hjun"><img src="https://avatars.githubusercontent.com/u/169322508?v=4?s=100" width="100px;" alt="j5hjun"/><br /><sub><b>j5hjun</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=j5hjun" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/marcFernandez"><img src="https://avatars.githubusercontent.com/u/32362792?v=4?s=100" width="100px;" alt="marcFernandez"/><br /><sub><b>marcFernandez</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=marcFernandez" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/mister-test"><img src="https://avatars.githubusercontent.com/u/212316706?v=4?s=100" width="100px;" alt="mister-test"/><br /><sub><b>mister-test</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=mister-test" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/n24q02m"><img src="https://avatars.githubusercontent.com/u/135627235?v=4?s=100" width="100px;" alt="n24q02m"/><br /><sub><b>n24q02m</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=n24q02m" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/oribarilan"><img src="https://avatars.githubusercontent.com/u/8760762?v=4?s=100" width="100px;" alt="oribi"/><br /><sub><b>oribi</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=oribarilan" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/pelidan"><img src="https://avatars.githubusercontent.com/u/45832535?v=4?s=100" width="100px;" alt="pelidan"/><br /><sub><b>pelidan</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=pelidan" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/xLillium"><img src="https://avatars.githubusercontent.com/u/16964936?v=4?s=100" width="100px;" alt="xLillium"/><br /><sub><b>xLillium</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=xLillium" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/CoolZxp"><img src="https://avatars.githubusercontent.com/u/54017765?v=4?s=100" width="100px;" alt="⁢4.435km/s"/><br /><sub><b>⁢4.435km/s</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=CoolZxp" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/drindr"><img src="https://avatars.githubusercontent.com/u/34709601?v=4?s=100" width="100px;" alt="Drin"/><br /><sub><b>Drin</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=drindr" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://hzu.lol/"><img src="https://avatars.githubusercontent.com/u/42469039?v=4?s=100" width="100px;" alt="Hakim Zulkufli"/><br /><sub><b>Hakim Zulkufli</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=hakimzulkufli" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://bit.ly/2N1ynXZ"><img src="https://avatars.githubusercontent.com/u/14874913?v=4?s=100" width="100px;" alt="Simon Klakegg"/><br /><sub><b>Simon Klakegg</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=sklakegg" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/sudorest"><img src="https://avatars.githubusercontent.com/u/214225921?v=4?s=100" width="100px;" alt="Kiwi"/><br /><sub><b>Kiwi</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=sudorest" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://trade.xyz/?ref=BZ1RJRXWO"><img src="https://avatars.githubusercontent.com/u/7317522?v=4?s=100" width="100px;" alt="Raxxoor"/><br /><sub><b>Raxxoor</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=dhaern" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/nyanyani"><img src="https://avatars.githubusercontent.com/u/11475482?v=4?s=100" width="100px;" alt="nyanyani"/><br /><sub><b>nyanyani</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=nyanyani" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://nettee.io/"><img src="https://avatars.githubusercontent.com/u/3953668?v=4?s=100" width="100px;" alt="nettee"/><br /><sub><b>nettee</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=nettee" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/atomlink-ye"><img src="https://avatars.githubusercontent.com/u/48194045?v=4?s=100" width="100px;" alt="Link"/><br /><sub><b>Link</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=atomlink-ye" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/blaszewski"><img src="https://avatars.githubusercontent.com/u/14119531?v=4?s=100" width="100px;" alt="Bartosz Łaszewski"/><br /><sub><b>Bartosz Łaszewski</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=blaszewski" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/huilang021x"><img src="https://avatars.githubusercontent.com/u/77293911?v=4?s=100" width="100px;" alt="huilang021x"/><br /><sub><b>huilang021x</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=huilang021x" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/dkovacevic15"><img src="https://avatars.githubusercontent.com/u/24757821?v=4?s=100" width="100px;" alt="Dusan Kovacevic"/><br /><sub><b>Dusan Kovacevic</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=dkovacevic15" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/jwcrystal"><img src="https://avatars.githubusercontent.com/u/121911854?v=4?s=100" width="100px;" alt="jwcrystal"/><br /><sub><b>jwcrystal</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=jwcrystal" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://zenstudio.cv/"><img src="https://avatars.githubusercontent.com/u/10528635?v=4?s=100" width="100px;" alt="Nguyen Canh Toan"/><br /><sub><b>Nguyen Canh Toan</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=ZenStudioLab" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/tom-dyar"><img src="https://avatars.githubusercontent.com/u/8899513?v=4?s=100" width="100px;" alt="Thomas Dyar"/><br /><sub><b>Thomas Dyar</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=tom-dyar" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/zuuky"><img src="https://avatars.githubusercontent.com/u/6713415?v=4?s=100" width="100px;" alt="zero"/><br /><sub><b>zero</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=zuuky" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/DenisBalan"><img src="https://avatars.githubusercontent.com/u/33955091?v=4?s=100" width="100px;" alt="Denis Balan"/><br /><sub><b>Denis Balan</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=DenisBalan" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/gustavocaiano"><img src="https://avatars.githubusercontent.com/u/104129313?v=4?s=100" width="100px;" alt="Gustavo Caiano"/><br /><sub><b>Gustavo Caiano</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=gustavocaiano" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/ThomasMldr"><img src="https://avatars.githubusercontent.com/u/6631765?v=4?s=100" width="100px;" alt="Thomas Mulder"/><br /><sub><b>Thomas Mulder</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=ThomasMldr" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/maou-shonen"><img src="https://avatars.githubusercontent.com/u/22576780?v=4?s=100" width="100px;" alt="魔王少年(maou shonen)"/><br /><sub><b>魔王少年(maou shonen)</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=maou-shonen" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/jelasin"><img src="https://avatars.githubusercontent.com/u/97788570?v=4?s=100" width="100px;" alt="  Jelasin"/><br /><sub><b>  Jelasin</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=jelasin" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/hannespr"><img src="https://avatars.githubusercontent.com/u/40021505?v=4?s=100" width="100px;" alt="Hannes"/><br /><sub><b>Hannes</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=hannespr" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://qwtoe.github.io/"><img src="https://avatars.githubusercontent.com/u/36733893?v=4?s=100" width="100px;" alt="mooozfxs"/><br /><sub><b>mooozfxs</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=qwtoe" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/zackslash"><img src="https://avatars.githubusercontent.com/u/2040617?v=4?s=100" width="100px;" alt="Luke Hines"/><br /><sub><b>Luke Hines</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=zackslash" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/andrewylies"><img src="https://avatars.githubusercontent.com/u/103019336?v=4?s=100" width="100px;" alt="m.seomoon"/><br /><sub><b>m.seomoon</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=andrewylies" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/yolo2h"><img src="https://avatars.githubusercontent.com/u/10754850?v=4?s=100" width="100px;" alt="Yolo"/><br /><sub><b>Yolo</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=yolo2h" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/xinxingi"><img src="https://avatars.githubusercontent.com/u/49302071?v=4?s=100" width="100px;" alt="XinXing"/><br /><sub><b>XinXing</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=xinxingi" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/eltociear"><img src="https://avatars.githubusercontent.com/u/22633385?v=4?s=100" width="100px;" alt="Ikko Eltociear Ashimine"/><br /><sub><b>Ikko Eltociear Ashimine</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=eltociear" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/dev-wantap"><img src="https://avatars.githubusercontent.com/u/69743540?v=4?s=100" width="100px;" alt="GWANWOO KIM"/><br /><sub><b>GWANWOO KIM</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=dev-wantap" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/OmerFarukOruc"><img src="https://avatars.githubusercontent.com/u/7347742?v=4?s=100" width="100px;" alt="Omer Faruk Oruc"/><br /><sub><b>Omer Faruk Oruc</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=OmerFarukOruc" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://khallaf.uk/"><img src="https://avatars.githubusercontent.com/u/51155980?v=4?s=100" width="100px;" alt="Omar Mohamed Khallaf"/><br /><sub><b>Omar Mohamed Khallaf</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=omar-mohamed-khallaf" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/Qesire"><img src="https://avatars.githubusercontent.com/u/102657430?v=4?s=100" width="100px;" alt="Knowingthesea_Qesire"/><br /><sub><b>Knowingthesea_Qesire</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Qesire" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="http://www.flyinghail.net/"><img src="https://avatars.githubusercontent.com/u/157430?v=4?s=100" width="100px;" alt="FENG Hao"/><br /><sub><b>FENG Hao</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=flyinghail" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/smatheusblu"><img src="https://avatars.githubusercontent.com/u/5666794?v=4?s=100" width="100px;" alt="Matheus Nogueira Silveira"/><br /><sub><b>Matheus Nogueira Silveira</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=smatheusblu" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/sktr"><img src="https://avatars.githubusercontent.com/u/44969514?v=4?s=100" width="100px;" alt="sktr"/><br /><sub><b>sktr</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=sktr" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/bobbyunknown"><img src="https://avatars.githubusercontent.com/u/62272380?v=4?s=100" width="100px;" alt="Insomnia"/><br /><sub><b>Insomnia</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=bobbyunknown" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/andrescastane"><img src="https://avatars.githubusercontent.com/u/13487870?v=4?s=100" width="100px;" alt="Andres Castañeda"/><br /><sub><b>Andres Castañeda</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=andrescastane" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://zaradacht.com/"><img src="https://avatars.githubusercontent.com/u/24251016?v=4?s=100" width="100px;" alt="Zaradacht Taifour (Zack)"/><br /><sub><b>Zaradacht Taifour (Zack)</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Zaradacht" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/fslse"><img src="https://avatars.githubusercontent.com/u/90545544?v=4?s=100" width="100px;" alt="fslse"/><br /><sub><b>fslse</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=fslse" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/linze0721"><img src="https://avatars.githubusercontent.com/u/178997622?v=4?s=100" width="100px;" alt="萧瑟"/><br /><sub><b>萧瑟</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=linze0721" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/SisyphusZheng"><img src="https://avatars.githubusercontent.com/u/146103794?v=4?s=100" width="100px;" alt="Zhi"/><br /><sub><b>Zhi</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=SisyphusZheng" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/824156793"><img src="https://avatars.githubusercontent.com/u/19755784?v=4?s=100" width="100px;" alt="lilili"/><br /><sub><b>lilili</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=824156793" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="http://mikehenke.com/"><img src="https://avatars.githubusercontent.com/u/119844?v=4?s=100" width="100px;" alt="Mike Henke"/><br /><sub><b>Mike Henke</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=mhenke" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/imVinayPandya"><img src="https://avatars.githubusercontent.com/u/5011197?v=4?s=100" width="100px;" alt="Vinay Pandya"/><br /><sub><b>Vinay Pandya</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=imVinayPandya" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/s-shank"><img src="https://avatars.githubusercontent.com/u/241541918?v=4?s=100" width="100px;" alt="Shank"/><br /><sub><b>Shank</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=s-shank" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://rgutzen.github.io/"><img src="https://avatars.githubusercontent.com/u/16289604?v=4?s=100" width="100px;" alt="Robin Gutzen"/><br /><sub><b>Robin Gutzen</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=rgutzen" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/dragon-Elec"><img src="https://avatars.githubusercontent.com/u/197374270?v=4?s=100" width="100px;" alt="Yash"/><br /><sub><b>Yash</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=dragon-Elec" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/Jiajun0413"><img src="https://avatars.githubusercontent.com/u/184531967?v=4?s=100" width="100px;" alt="Liu Jiajun"/><br /><sub><b>Liu Jiajun</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Jiajun0413" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/umi008"><img src="https://avatars.githubusercontent.com/u/200843810?v=4?s=100" width="100px;" alt="Ulises Millán"/><br /><sub><b>Ulises Millán</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=umi008" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/HighColdHC"><img src="https://avatars.githubusercontent.com/u/35870222?v=4?s=100" width="100px;" alt="HighColdHC"/><br /><sub><b>HighColdHC</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=HighColdHC" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://hardcore.engineer/about"><img src="https://avatars.githubusercontent.com/u/401815?v=4?s=100" width="100px;" alt="Stephan Schielke"/><br /><sub><b>Stephan Schielke</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=stephanschielke" title="Code">💻</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

---

## 📄 许可证

MIT
