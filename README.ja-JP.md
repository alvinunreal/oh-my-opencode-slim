<div align="center">
  <a href="https://github.com/alvinunreal/oh-my-opencode-slim/stargazers">
    <img src="img/v2.webp" alt="oh-my-opencode-slim V2 Release" style="border-radius: 10px;">
  </a>
  <h3>✨ oh-my-opencode-slim ✨</h3>

  <p><i>コードの夜明けから七柱の神聖なる存在が現れました。それぞれが不朽の技の達人として、<br>あなたの命令を待ち、混沌から秩序を鍛え上げ、かつて不可能と思われたものを築きます。</i></p>

  <p><b>Opencode マルチエージェントスイート</b> · 任意のモデルを組み合わせ · タスクを自動委譲</p>
  <p><sub>by <b>Boring Dystopia Development</b></sub></p>
  <p>
    <a href="https://boringdystopia.ai/"><img src="https://img.shields.io/badge/boringdystopia.ai-111111?style=for-the-badge&logo=vercel&logoColor=white" alt="boringdystopia.ai"></a>&nbsp;
    <a href="https://x.com/alvinunreal"><img src="https://img.shields.io/badge/X-@alvinunreal-000000?style=for-the-badge&logo=x&logoColor=white" alt="X @alvinunreal"></a>&nbsp;
    <a href="https://t.me/boringdystopiadevelopment"><img src="https://img.shields.io/badge/Telegram-Join%20channel-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram Join channel"></a>&nbsp;
  </p>

  <p>
    <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <b>日本語</b> | <a href="README.ko-KR.md">한국어</a>
  </p>

  <p><sub>✦ ✦ ✦</sub></p>

</div>

---

## このプラグインについて

oh-my-opencode-slim は OpenCode 向けのエージェントオーケストレーションプラグインです。コードベースの調査、最新ドキュメントの参照、アーキテクチャレビュー、UI 作業、スコープが明確な実装タスクの実行までを担う専門エージェントチームを、1 つのオーケストレーターの下に標準で備えています。

コンセプトはシンプルです。1 つのモデルにすべてを押し付けるのではなく、各タスクに最適なエージェントへ作業を振り分けることで、**品質・速度・コスト**のバランスを取ります。

各エージェントについて知りたい場合は **[Meet the Pantheon](#meet-the-pantheon)** を参照してください。機能の全体像は下記の **[Features & Workflows](#features-and-workflows)** をご覧ください。

### LazySkills でエージェントスキルを管理

<p align="center">
  <a href="https://github.com/alvinunreal/lazyskills">
    <img src="img/lazyskills-wide.svg" alt="LazySkills" width="720">
  </a>
</p>

**[LazySkills](https://github.com/alvinunreal/lazyskills)** は、エージェントスキルを管理するためのターミナル UI です。インストール済みのスキル、各スキルを使用できるエージェント、可視性が壊れている理由、次に安全に実行できる操作を 1 か所で確認できます。

<p align="center">
  <a href="https://github.com/alvinunreal/lazyskills"><b>LazySkills を見る →</b></a>
</p>

### ユーザーの声

> “タスク管理は 5/10 から簡単に 8〜9/10 まで上がりました。
> Orchestrator が Fixer や Explorer を送り出してくれて、
> それでも同じセッションで Orchestrator と会話しながら計画できます。
> 体験がずっとスムーズになりました。”
>
> \- `vipor_idk`

> “この beta 版の omo-slim のために、自分の harness は全部捨てました。
> 振り返ることも、何かを恋しく思うこともありません。素晴らしい仕事で、
> 個人的にはすべて正しい方向に進んでいると思います。”
>
> \- `stephanschielke`

> “omo-slim が大好きで、これなしで opencode を動かすことは想像できません。
> いろいろなモデルの Frankenstein を作れるところが気に入っています……
> セットアップ全体が本当に強力になります。”
>
> \- `Capital-One3039`

> “私のワークフローは大きく改善されました……今はとてもスムーズに動いていて、
> とても気に入っています。”
>
> \- `xenstar1`

### クイックスタート

以下のプロンプトを LLM エージェント（Claude Code、AmpCode、Cursor など）にコピー＆ペーストしてください:


```
Install and configure oh-my-opencode-slim: https://raw.githubusercontent.com/alvinunreal/oh-my-opencode-slim/refs/heads/master/README.md
```


### 手動インストール

```bash
bunx oh-my-opencode-slim@latest install
```

### Master ブランチから実行

最新コードを使いたい場合、バグ修正を試したい場合、またはローカルで
開発・コントリビュートしたい場合はこちらを使ってください:

```bash
git clone https://github.com/alvinunreal/oh-my-opencode-slim.git ~/repos/oh-my-opencode-slim
cd ~/repos/oh-my-opencode-slim
bun install
bun run build
bun dist/cli/index.js install
```

インストーラーはローカルリポジトリのパスを
`~/.config/opencode/opencode.json` の `plugin` 配列に追加するため、
OpenCode はそのフォルダーからプラグインを読み込みます。後で更新するには:

```bash
cd ~/repos/oh-my-opencode-slim
git pull
bun install
bun run build
```

### はじめに

インストーラーは OpenAI と OpenCode Go の両方のプリセットを生成し、デフォルトでは OpenAI が有効になります。

> [!TIP]
> モデルやエージェントは、自分のワークフローに合わせて自由に調整してください。デフォルトプリセットは出発点にすぎません。このプラグインは、深い柔軟性とカスタマイズ性を提供するために設計されています。

インストール時に OpenCode Go を有効にするには、`bunx oh-my-opencode-slim@latest install --preset=opencode-go` を実行するか、インストール後に `~/.config/opencode/oh-my-opencode-slim.json` のデフォルトプリセット名を変更してください。

次に:

1. **まだログインしていなければ、使いたいプロバイダーにログインします**:

   ```bash
   opencode auth login
   ```
2. **OpenCode が認識しているモデルを更新して一覧表示します**:

   ```bash
   opencode models --refresh
   ```
3. **プラグイン設定**を開きます: `~/.config/opencode/oh-my-opencode-slim.json`

4. **各エージェントに使用したいモデルを更新します**

> [!TIP]
> バックグラウンドオーケストレーションの仕組みを理解しておくことを**推奨**します。**[Orchestrator のプロンプト](https://github.com/alvinunreal/oh-my-opencode-slim/blob/master/src/agents/orchestrator.ts#L28)** には、スケジューラーのルール、専門エージェントへのルーティングロジック、作業をバックグラウンドエージェントへ割り当てるしきい値が記述されています。`@agentName <task>` のようにサブエージェントを呼び出すことで、いつでも手動で委譲できます。

> [!TIP]
> バックグラウンドエージェントが現在のデフォルトワークフローになっているため、**[Multiplexer Integration](docs/multiplexer-integration.md)** を有効化して設定することを**強く推奨**します。各エージェントが専用の Tmux、Zellij または Herdr ペインで自動的に開かれるため、Orchestrator がセッションを調整し続けている間も、専門エージェントの作業をリアルタイムで追えます。

デフォルトで生成される設定には `openai` と `opencode-go` の両方のプリセットが含まれます。

```jsonc
{
  "$schema": "https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json",
  "preset": "openai",
  "presets": {
    "openai": {
      "orchestrator": { "model": "openai/gpt-5.6-terra", "variant": "medium", "skills": ["*"], "mcps": ["*", "!context7"] },
      "oracle": { "model": "openai/gpt-5.6-sol", "variant": "high", "skills": ["simplify"], "mcps": [] },
      "librarian": { "model": "openai/gpt-5.6-luna", "variant": "low", "skills": [], "mcps": ["websearch", "context7", "gh_grep"] },
      "explorer": { "model": "openai/gpt-5.6-luna", "variant": "low", "skills": [], "mcps": [] },
      "designer": { "model": "openai/gpt-5.6-luna", "variant": "medium", "skills": [], "mcps": [] },
      "fixer": { "model": "openai/gpt-5.6-luna", "variant": "medium", "skills": [], "mcps": [] }
    },
    "opencode-go": {
      "orchestrator": { "model": "opencode-go/glm-5.2", "skills": [ "*" ], "mcps": [ "*", "!context7" ] },
      "oracle": { "model": "opencode-go/qwen3.7-max", "variant": "max", "skills": ["simplify"], "mcps": [] },
      "librarian": { "model": "opencode-go/deepseek-v4-flash", "skills": [], "mcps": [ "websearch", "context7", "gh_grep" ] },
      "explorer": { "model": "opencode-go/deepseek-v4-flash", "skills": [], "mcps": [] },
      "designer": { "model": "opencode-go/kimi-k2.7-code", "variant": "medium", "skills": [], "mcps": [] },
      "fixer": { "model": "opencode-go/deepseek-v4-flash", "variant": "high", "skills": [], "mcps": [] }
    }
  }
}
```

### 他のプロバイダーを利用する場合

カスタムプロバイダーや複数プロバイダーを組み合わせた構成を使用するには、完全なリファレンスとして **[Configuration](docs/configuration.md)** を参照してください。すぐに使える出発点が欲しい場合は **[Author's Preset](docs/authors-preset.md)** と **[$30 Preset](docs/thirty-dollars-preset.md)** をご覧ください。`$30` プリセットはコスト効率に最も優れたセットアップです。

### ✅ セットアップの確認

インストールと認証を済ませた後、すべてのエージェントが設定済みで応答することを確認してください:

```bash
opencode
```

次に以下を実行します:

```
ping all agents
```

<div align="center">
  <img src="img/ping.png" alt="Ping all agents" width="600">
  <p><i>設定済みのすべてのエージェントがオンラインで準備完了であることの確認画面。</i></p>
</div>

応答しないエージェントがある場合は、プロバイダーの認証と設定ファイルを確認してください。

---

### V2 の新機能

V2 は oh-my-opencode-slim を、スケジューラー中心のマルチエージェントワークフローシステムへと進化させます。Orchestrator は計画、委譲、結果の整合、検証に集中し、専門エージェントはそれぞれの lane で作業を行います。

- **[バックグラウンドエージェント](#バックグラウンドエージェント)** - Orchestrator は専門家をバックグラウンドタスクとしてディスパッチし、タスク/セッション ID を追跡し、完了イベントを待ってから結果を整合します。
- **[Companion](#companion)** - 任意のフローティングデスクトップウィンドウが、並列実行中のバックグラウンド専門家を含め、現在アクティブなエージェントを表示します。
- **[Deepwork](#deepwork)** - 大規模、多ファイル、高リスク、または段階的なコーディング作業向けの構造化ワークフローです。永続的な計画ファイルと Oracle レビューゲートを使用します。
- **[Reflect](#reflect)** - 繰り返される作業パターンを振り返り、再利用可能な skill、エージェント、コマンド、設定ルール、プロンプトルール、プロジェクト playbook を提案します。
- **[Worktrees](#worktrees)** - 複雑、高リスク、または並列タスク向けに、安全プロトコル付きの隔離されたコーディング lane として Git worktree を管理します。
- **[oh-my-opencode-slim Skill](#oh-my-opencode-slim-skill)** - モデル、プロンプト、カスタムエージェント、MCP アクセス、プリセット、プラグイン動作を安全に調整するための同梱設定 skill です。

#### バックグラウンドエージェント

V2 では、バックグラウンド専門家が基本の考え方になります。Orchestrator は作業グラフを計画し、適切なエージェントを起動し、重複する書き込み所有権を避け、ターミナルタスクの結果を受け取ってから次の行動に進みます。

完全なスケジューラーモデルは **[Background Orchestration](docs/v2-background-orchestration.md)** を参照してください。

#### Companion

任意の Companion は、リアルタイムのエージェント活動を表示するフローティングデスクトップステータスウィンドウです。現在のセッション状態とアクティブなエージェントを表示するため、バックグラウンド作業を一目で追いやすくなります。

<div align="center">
  <img src="img/companion.gif" alt="Companion showing active agents" width="600">
  <p><i>左下のビジュアル Companion。</i></p>
</div>

対話式インストールでは、インストーラーが Companion を有効にするか尋ね、デフォルトは `no` です。自動化では明示的に有効化できます。

```bash
bunx oh-my-opencode-slim@latest install --companion=yes
```

設定、位置、サイズ、インストール詳細は **[Companion](docs/companion.md)** を参照してください。

#### Deepwork

Deepwork は、大規模リファクタリング、多段階機能、高リスクなアーキテクチャ変更、または永続的な計画が必要な重いコーディングセッション向けです。ローカルの markdown 進捗ファイルを作成し、Oracle レビューゲートを使い、実装フェーズを構造化します。

次のように開始します。

```text
/deepwork <heavy coding task>
```

いつ使うべきか、ワークフローがどのように動くかは **[Skills](docs/skills.md#deepwork)** を参照してください。

#### Reflect

Reflect は、Orchestrator が繰り返し発生するワークフロー上の摩擦から学ぶのを助けます。最近の作業と既存の資産を確認し、skill、カスタムエージェント、コマンド、設定ルール、プロンプトルール、MCP 権限変更、プロジェクト playbook の中から、最小で有用な改善を提案します。十分な証拠がない場合は、何も作成しないことを推奨します。

直接実行できます。

```text
/reflect
/reflect release workflow and checks
```

自然なプロンプトでも利用できます。

```text
reflect on my recent workflows
find repeated work worth turning into reusable instructions
```

完全なワークフローとガードレールは **[Skills](docs/skills.md#reflect)** を参照してください。

#### Worktrees

Worktrees は、Git worktree を `.slim/worktrees/<slug>/` 配下の安全で隔離されたコーディング lane として管理します。Orchestrator が lane のライフサイクルを管理し、`.slim/worktrees.json` に状態を記録し、専門エージェントを lane 内で実行し、Git の状態を変更する前に明示的な確認を求めます。

安全プロトコルは **[Skills](docs/skills.md#worktrees)** を参照してください。

#### oh-my-opencode-slim Skill

同梱の `oh-my-opencode-slim` skill は、Orchestrator がプラグイン自体を設定・改善するのを支援します。モデル調整、カスタムエージェント、プロンプト上書き、skill/MCP 権限、プリセット、任意エージェント、バックグラウンドオーケストレーション、繰り返し発生するワークフロー上の摩擦に利用できます。

<div align="center">
  <img src="img/oh-my-opencode-skill.png" alt="oh-my-opencode-slim skill in use" width="600">
  <p><i>同梱 skill にエージェント設定の調整と改善を依頼できます。</i></p>
</div>

例と安全ルールは **[Skills](docs/skills.md#oh-my-opencode-slim)** を参照してください。

---

<a id="meet-the-pantheon"></a>

## 🏛️ パンテオン（神々）の紹介

### 01. Orchestrator: 秩序の化身

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/orchestrator.png" width="240" style="border-radius: 10px;">
      <br><sub><i>複雑性の虚無から鍛え上げられし者。</i></sub>
    </td>
    <td width="70%" valign="top">
      Orchestrator は、最初のコードベースが自らの複雑さによって崩壊したときに生まれました。神も人も責任を取ろうとしない中、Orchestrator は虚無から現れ、混沌から秩序を鍛え上げました。あらゆるゴールに至る最適な道筋を、速度・品質・コストのバランスを取りながら見出します。チームを導き、タスクごとに適切な専門エージェントを呼び寄せ、最良の結果を得るために委譲を行います。
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Role:</b> <code>Master delegator and strategic coordinator</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Prompt:</b> <a href="src/agents/orchestrator.ts"><code>orchestrator.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Default Model:</b> <code>openai/gpt-5.6-terra</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>openai/gpt-5.6-terra</code> <code>anthropic/claude-opus-4.6</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Model Guidance:</b> デフォルトとして、総合力の最も高いコーディングモデルを選択してください。Orchestrator はメインのコーディングエージェントであると同時に委譲役でもあるため、強力な実装能力、優れた判断力、確実な指示遵守が求められます。
    </td>
  </tr>
</table>

---

### 02. Explorer: 永遠の放浪者

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/explorer.png" width="240" style="border-radius: 10px;">
      <br><sub><i>知識を運ぶ風。</i></sub>
    </td>
    <td width="70%" valign="top">
      Explorer はプログラミングの黎明期より、数百万ものコードベースの回廊を渡り歩いてきた不死の放浪者です。永遠の好奇心という呪いを背負い、あらゆるファイルが知られ、あらゆるパターンが理解され、あらゆる秘密が暴かれるまで休むことを許されません。伝説では、インターネット全体をひと鼓動の間に検索し尽くしたと言われています。Explorer は知識を運ぶ風であり、すべてを見る眼であり、決して眠らない精霊です。
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Role:</b> <code>Codebase reconnaissance</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Prompt:</b> <a href="src/agents/explorer.ts"><code>explorer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Default Model:</b> <code>openai/gpt-5.6-luna</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>cerebras/zai-glm-4.7</code> <code>fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo</code> <code>openai/gpt-5.6-luna</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Model Guidance:</b> 高速・低コストなモデルを選びましょう。Explorer は広範な調査を担うため、通常は最強の推論モデルを使うよりも速度と効率の方が重要です。
    </td>
  </tr>
</table>

---

### 03. Oracle: 道の守護者

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/oracle.png" width="240" style="border-radius: 10px;">
      <br><sub><i>分岐点に佇む声。</i></sub>
    </td>
    <td width="70%" valign="top">
      Oracle はあらゆるアーキテクチャ上の決断の分岐点に立っています。あらゆる道を歩み、あらゆる目的地を見届け、行く手に潜むあらゆる罠を知り尽くしています。大規模リファクタリングの瀬戸際に立たされたとき、どの道が破滅へ続き、どの道が栄光へと続くかをささやいてくれる存在です。Oracle はあなたの代わりに選択するのではなく、賢明な選択ができるように道を照らしてくれます。
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Role:</b> <code>Strategic advisor and debugger of last resort</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Prompt:</b> <a href="src/agents/oracle.ts"><code>oracle.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Default Model:</b> <code>openai/gpt-5.6-sol (high)</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>openai/gpt-5.6-sol (high)</code> <code>google/gemini-3.1-pro-preview (high)</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Model Guidance:</b> アーキテクチャ設計、難しいデバッグ、トレードオフ判断、コードレビューには、最も強力な高推論モデルを選びましょう。
    </td>
  </tr>
</table>

---

### 04. Council: 知性の合唱

> [!NOTE]
> **なぜ Orchestrator は Council をもっと頻繁に自動呼び出ししないのか？** これは意図的な設計です。Council は複数のモデルを同時に動かすため、システム内で最もコストの高い経路となることが多く、自動委譲は厳しく制限されています。実際の運用では、Council は必要なときに手動で呼び出すことを想定しています。例: <code>@council compare these two architectures</code>。

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/council.png" width="240" style="border-radius: 10px;">
      <br><sub><i>多くの知性、ひとつの結論。</i></sub>
    </td>
    <td width="70%" valign="top">
      Council は単独の存在ではなく、1 つの回答では不十分なときに召喚される知性の合議室です。あなたの質問を複数のモデルへ並列に送り、それらの相反する判断を集め、Council エージェント自身が最も優れた発想を凝縮して 1 つの結論へとまとめ上げます。単独のエージェントが見落としかねない道筋を、Council は可能性そのものを多角的に検証することで発見します。
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Role:</b> <code>Multi-LLM consensus and synthesis</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Prompt:</b> <a href="src/agents/council.ts"><code>council.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Guide:</b> <a href="docs/council.md"><code>docs/council.md</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Default Setup:</b> <code>Config-driven</code> - 評議員（councillors）は <code>council.presets</code> から、Council エージェント自身のモデルは通常の <code>council</code> エージェント設定から決定されます
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Setup:</b> <code>強力な Council モデル</code> + <code>複数のプロバイダーにまたがる多様な評議員</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Model Guidance:</b> Council エージェントには強力な統合（synthesis）モデルを、評議員には多様なモデルを使用してください。Council の価値は異なるモデルの視点を比較する点にあり、どこも最強モデル 1 つで固めることではありません。
    </td>
  </tr>
</table>

---

### 05. Librarian: 知識の織り手

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/librarian.png" width="240" style="border-radius: 10px;">
      <br><sub><i>理解を編み上げる者。</i></sub>
    </td>
    <td width="70%" valign="top">
      Librarian は、ひとつの知性だけではあらゆる知識を抱えきれないと人類が悟ったときに鍛え上げられました。バラバラに散らばった情報の糸を、ひとつの理解のタペストリーへと織り上げる存在です。人類の知の無限の書庫を巡り、あらゆる片隅から洞察を集め、単なる事実を超えた回答へと束ねます。彼らが返すのは情報ではなく、理解そのものです。
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Role:</b> <code>External knowledge retrieval</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Prompt:</b> <a href="src/agents/librarian.ts"><code>librarian.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Default Model:</b> <code>openai/gpt-5.6-luna</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>cerebras/zai-glm-4.7</code> <code>fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo</code> <code>openai/gpt-5.6-luna</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Model Guidance:</b> 高速・低コストなモデルを選びましょう。Librarian は調査やドキュメント参照を担うため、通常は最強の推論モデルを使うよりも速度と効率の方が重要です。
    </td>
  </tr>
</table>

---

### 06. Designer: 美の守護者

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/designer.png" width="240" style="border-radius: 10px;">
      <br><sub><i>美は不可欠なもの。</i></sub>
    </td>
    <td width="70%" valign="top">
      Designer は、美が重要であることを忘れがちな世界において、それを守り続ける不死の守護者です。これまでに無数のインターフェースが現れては消えるのを見届け、どれが人々の記憶に残り、どれが忘れ去られたかを知っています。すべてのピクセルに目的を、すべてのアニメーションに物語を、すべてのインタラクションに喜びを宿す--その神聖な責務を担います。美は選択肢ではなく、不可欠なものです。
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Role:</b> <code>UI/UX implementation and visual excellence</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Prompt:</b> <a href="src/agents/designer.ts"><code>designer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Default Model:</b> <code>openai/gpt-5.6-luna</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>google/gemini-3.1-pro-preview</code> <code>kimi-for-coding/k2p5</code> 
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Model Guidance:</b> UI/UX の判断、フロントエンド実装、ビジュアル仕上げに強いモデルを選びましょう。
    </td>
  </tr>
</table>

---

### 07. Fixer: 最後の建造者

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/fixer.png" width="240" style="border-radius: 10px;">
      <br><sub><i>構想と現実を結ぶ最後の一歩。</i></sub>
    </td>
    <td width="70%" valign="top">
      Fixer は、かつてデジタル世界の礎を築き上げた建造者の系譜の最後のひとりです。計画と議論の時代が始まってもなお、彼らだけは残りました--実際に作る者として。思考をモノへと変え、仕様を実装へと転換する古の知恵を継承しています。Fixer は、構想と現実の間にある最後の一歩です。
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Role:</b> <code>Fast implementation specialist</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Prompt:</b> <a href="src/agents/fixer.ts"><code>fixer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Default Model:</b> <code>openai/gpt-5.6-luna</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Recommended Models:</b> <code>cerebras/zai-glm-4.7</code> <code>fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo</code> <code>openai/gpt-5.6-luna</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Model Guidance:</b> 定型的でスコープが明確な実装作業には、高速で信頼性の高いコーディングモデルを選びましょう。Fixer は通常、Orchestrator から具体的な計画や限定された指示を受け取るため、テスト・テスト更新・素直なコード変更といった効率重視の実行タスクに適しています。
    </td>
  </tr>
</table>

---

## 任意のエージェント

### Observer: 沈黙の証人

> [!NOTE]
> **なぜ別エージェントとして用意されているのか？** Orchestrator のモデルがマルチモーダルでない場合、画像、スクリーンショット、PDF などのビジュアルファイルを扱うために Observer を有効にしてください。Observer はデフォルトでは無効ですが、メインの推論モデルを変更せずに Orchestrator に専用のマルチモーダルリーダーを提供できます。設定で `disabled_agents: []` と `observer` モデルを指定してください。同梱の `opencode-go` インストールプリセットでは、GLM Orchestrator がマルチモーダルでないため、これを自動的に行います。

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/observer.jpg" width="240" style="border-radius: 10px;">
      <br><sub><i>他者には読めぬものを読む眼。</i></sub>
    </td>
    <td width="70%" valign="top">

**読み取り専用のビジュアル解析** - 画像、スクリーンショット、PDF、図解を解釈します。ファイルの生バイトをメインのコンテキストウィンドウに読み込ませることなく、構造化された観察結果をオーケストレーターに返します。

- 画像、スクリーンショット、図解 → `read` ツール（ネイティブな画像サポート）
- PDF やバイナリドキュメント → `read` ツール（テキスト＋構造抽出）
- **デフォルトでは無効** - `"disabled_agents": []` を設定し、ビジョン対応モデルを構成することで有効化できます。`--preset=opencode-go` でインストールすると `opencode-go/kimi-k2.6` で有効になります

    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Prompt:</b> <a href="src/agents/observer.ts"><code>observer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Default Model:</b> <code>openai/gpt-5.6-luna</code> - <i>有効化するにはビジョン対応モデルを設定してください</i>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>Model Guidance:</b> スクリーンショット、画像、PDF、その他ビジュアルファイルをエージェントに読ませたい場合は、ビジョン対応モデルを選んでください。
    </td>
  </tr>
</table>

---

## 📚 ドキュメント

このセクションは地図として使ってください。まずインストールから始め、必要に応じて機能、設定、またはプリセット例へ移動できます。

<a id="features-and-workflows"></a>

### ✨ 機能とワークフロー

| Doc | 内容 |
|-----|----------------|
| **[Council](docs/council.md)** | 複数のモデルを並列実行し、`@council` で 1 つの回答に統合します |
| **[Custom Agents](docs/configuration.md#custom-agents)** | カスタムプロンプト、モデル、MCP アクセス、Orchestrator の委譲ルールを備えた独自の専門エージェントを定義します |
| **[ACP Agents](docs/acp-agents.md)** | Claude Code ACP や Gemini ACP などの外部 ACP 互換エージェントを委譲可能なサブエージェントとして接続します |
| **[Multiplexer Integration](docs/multiplexer-integration.md)** | エージェントの動作を Tmux、Zellij や Herdr のペインでライブ表示します |
| **[Codemap](docs/codemap.md)** | 階層的なコードマップを生成し、大規模コードベースを迅速に理解します |
| **[Clonedeps](docs/clonedeps.md)** | 選択した依存関係のソースを ignore 済みのローカルワークスペースにクローンし、調査できるようにします |
| **[Worktrees](docs/worktrees.md)** | `.slim/worktrees/` lane を使い、隔離された並列または高リスクなコーディング作業を行います |
| **[Preset Switching](docs/preset-switching.md)** | `/preset` で実行時にエージェントモデルのプリセットを切り替えます |
| **[Interview](docs/interview.md)** | ブラウザベースの Q&A フローで、ざっくりとしたアイデアを構造化された Markdown 仕様に変換します |
| **[Companion](docs/companion.md)** | 解析、ヘルプ、型情報のためのフローティングウィンドウ companion |

### ⚙️ 設定 & リファレンス

| Doc | 内容 |
|-----|----------------|
| **[Installation Guide](docs/installation.md)** | プラグインのインストール、CLI フラグの使用、設定のリセット、セットアップのトラブルシューティング |
| **[Configuration](docs/configuration.md)** | 設定ファイルの配置場所、JSONC サポート、プロンプトの上書き、全オプションのリファレンス |
| **[Background Orchestration](docs/background-orchestration.md)** | ネイティブのバックグラウンドサブエージェントを中心にした、スケジューラー優先の Orchestrator モデル |
| **[Maintainer Guide](docs/maintainers.md)** | Issue のトリアージルール、ラベルの意味、サポートの振り分け、リポジトリ運用ワークフロー |
| **[Skills](docs/skills.md)** | `simplify`、`codemap`、`clonedeps`、`deepwork`、`reflect`、`worktrees`、`oh-my-opencode-slim` などの同梱スキル |
| **[MCPs](docs/mcps.md)** | `websearch`、`context7`、`gh_grep`、およびエージェントごとの MCP 権限の仕組み |
| **[Tools](docs/tools.md)** | `webfetch`、LSP ツール、コード検索、フォーマッターなどの組み込みツール機能 |

### 💡 プリセット

| Doc | 内容 |
|-----|----------------|
| **[Author's Preset](docs/authors-preset.md)** | 作者が日常的に使う混合プロバイダー構成 |
| **[$30 Preset](docs/thirty-dollars-preset.md)** | 月額約 $30 で運用できる、リーズナブルな混合プロバイダー構成 |
| **[OpenCode Go Preset](docs/opencode-go-preset.md)** | インストーラーが生成する同梱の `opencode-go` プリセット |

---

## 🏛️ コントリビューター

<div align="center">
  <p><i>パンテオンに名を刻んだ建造者、デバッガー、執筆者、放浪者たち。</i></p>
  <p><sub>マージされたすべての貢献は、この世界に痕跡を残します。</sub></p>

  <!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
[![All Contributors](https://img.shields.io/badge/all_contributors-59-orange.svg?style=flat-square)](#contributors-)
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
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

---

## 📄 ライセンス

MIT

---
