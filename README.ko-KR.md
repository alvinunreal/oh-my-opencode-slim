<div align="center">
  <a href="https://github.com/alvinunreal/oh-my-opencode-slim/stargazers">
    <img src="img/v2beta.webp" alt="V2 Beta Release" style="border-radius: 10px;">
  </a>
  <h3>✨ V2 베타 릴리스: 백그라운드 오케스트레이션이 도착했습니다 ✨</h3>
  <p><i>오케스트레이터가 이제 백그라운드에서 전문 에이전트를 스케줄링하고,<br><code>/deepwork</code>가 큰 목표를 파일 기반 계획으로 변환합니다.<br>베타 테스터 여러분, Telegram에서 피드백을 공유해 주세요.</i></p>

  <p><b>오픈 멀티 에이전트 스위트</b> · 모델 자유 조합 · 작업 자동 위임</p>

  <p><sub>제작: <b>Boring Dystopia Development</b></sub></p>
  <p>
    <a href="https://boringdystopia.ai/"><img src="https://img.shields.io/badge/boringdystopia.ai-111111?style=for-the-badge&logo=vercel&logoColor=white" alt="boringdystopia.ai"></a>&nbsp;
    <a href="https://x.com/alvinunreal"><img src="https://img.shields.io/badge/X-@alvinunreal-000000?style=for-the-badge&logo=x&logoColor=white" alt="X @alvinunreal"></a>&nbsp;
    <a href="https://t.me/boringdystopiadevelopment"><img src="https://img.shields.io/badge/Telegram-Join%20channel-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram Join channel"></a>&nbsp;
  </p>

  <p>
    <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja-JP.md">日本語</a> | <b>한국어</b>
  </p>
</div>

---

## Oh My OpenCode Slim

oh-my-opencode-slim은 OpenCode용 에이전트 오케스트레이션 플러그인입니다. 코드베이스 정찰, 최신 문서 조회, 아키텍처 리뷰, UI 작업, 잘 정의된 범위의 구현 작업까지 처리하는 전문 에이전트 팀이 내장되어 있으며, 모두 하나의 오케스트레이터 아래에서 동작합니다.

핵심 아이디어는 간단합니다. 하나의 모델이 모든 작업을 처리하도록 강제하는 대신, 각 작업에 가장 적합한 에이전트로 라우팅하여 **품질, 속도, 비용**의 균형을 맞춥니다.

에이전트 자체를 살펴보려면 **[판테온 만나보기](#meet-the-pantheon)** 를 참고하세요. 전체 기능 목록은 아래의 **[기능 & 워크플로우](#features-and-workflows)** 에서 확인할 수 있습니다.

### 빠른 시작

이 프롬프트를 복사해서 LLM 에이전트(Claude Code, AmpCode, Cursor 등)에 붙여넣으세요:


```
Install and configure oh-my-opencode-slim: https://raw.githubusercontent.com/alvinunreal/oh-my-opencode-slim/refs/heads/master/README.md
```


### 수동 설치

```bash
bunx oh-my-opencode-slim@latest install
```

### V2 백그라운드 오케스트레이션 베타

V2는 오케스트레이터를 기본 실행 워커에서 스케줄러로 변경합니다. 작업을 계획하고, 전문 에이전트를 백그라운드 작업으로 디스패치한 다음, 상태를 폴링하여 결과를 조정한 뒤 계속 진행합니다. 이를 위해 OpenCode의 네이티브 백그라운드 서브에이전트 지원이 필요하므로, 베타 사용자는 실험적 플래그를 활성화한 상태로 OpenCode를 시작해야 합니다.

```bash
bunx oh-my-opencode-slim@beta install
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1 opencode
```

### 시작하기

인스톨러는 OpenAI와 OpenCode Go 프리셋을 모두 생성하며, 기본적으로 OpenAI가 활성화됩니다. OpenAI는 판단력이 높은 에이전트에 `openai/gpt-5.5`를, 빠른 범위 작업 에이전트에 `openai/gpt-5.4-mini`를 사용합니다. 설치 시 OpenCode Go를 활성화하려면 `bunx oh-my-opencode-slim@latest install --preset=opencode-go`를 실행하거나, 설치 후 `~/.config/opencode/oh-my-opencode-slim.json`에서 기본 프리셋 이름을 변경하세요.

그 다음:

1. **아직 로그인하지 않았다면, 사용할 프로바이더에 로그인하세요**:

   ```bash
   opencode auth login
   ```
2. **OpenCode에서 사용할 수 있는 모델 목록을 새로고침하세요**:

   ```bash
   opencode models --refresh
   ```
3. **플러그인 설정 파일**을 `~/.config/opencode/oh-my-opencode-slim.json`에서 엽니다.

4. **각 에이전트에 사용할 모델을 업데이트합니다**

> [!TIP]
> 자동 위임이 어떻게 동작하는지 이해하는 것을 **권장**합니다. **[Orchestrator 프롬프트](https://github.com/alvinunreal/oh-my-opencode-slim/blob/master/src/agents/orchestrator.ts#L28)** 에는 위임 규칙, 전문 에이전트 라우팅 로직, 메인 에이전트가 언제 서브에이전트로 작업을 넘겨야 하는지에 대한 임계값이 포함되어 있습니다. 수동으로 위임하려면 `@agentName <task>`로 서브에이전트를 호출하면 됩니다.

기본 생성 설정에는 `openai`와 `opencode-go` 프리셋이 모두 포함되어 있습니다.

```jsonc
{
  "$schema": "https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json",
  "preset": "openai",
  "presets": {
    "openai": {
      "orchestrator": { "model": "openai/gpt-5.5", "skills": ["*"], "mcps": ["*", "!context7"] },
      "oracle": { "model": "openai/gpt-5.5", "variant": "high", "skills": ["simplify"], "mcps": [] },
      "librarian": { "model": "openai/gpt-5.4-mini", "variant": "low", "skills": [], "mcps": ["websearch", "context7", "grep_app"] },
      "explorer": { "model": "openai/gpt-5.4-mini", "variant": "low", "skills": [], "mcps": [] },
      "designer": { "model": "openai/gpt-5.4-mini", "variant": "medium", "skills": [], "mcps": [] },
      "fixer": { "model": "openai/gpt-5.4-mini", "variant": "low", "skills": [], "mcps": [] }
    },
    "opencode-go": {
      "orchestrator": { "model": "opencode-go/glm-5.1", "skills": [ "*" ], "mcps": [ "*", "!context7" ] },
      "oracle": { "model": "opencode-go/deepseek-v4-pro", "variant": "max", "skills": ["simplify"], "mcps": [] },
      "council": { "model": "opencode-go/deepseek-v4-pro", "variant": "high", "skills": [], "mcps": [] },
      "librarian": { "model": "opencode-go/minimax-m2.7", "skills": [], "mcps": [ "websearch", "context7", "grep_app" ] },
      "explorer": { "model": "opencode-go/minimax-m2.7", "skills": [], "mcps": [] },
      "designer": { "model": "opencode-go/kimi-k2.6", "variant": "medium", "skills": [], "mcps": [] },
      "fixer": { "model": "opencode-go/deepseek-v4-flash", "variant": "high", "skills": [], "mcps": [] }
    }
  }
}
```

### 대체 프로바이더 사용하기

커스텀 프로바이더나 여러 프로바이더를 혼합해서 사용하려면, **[Configuration](docs/configuration.md)** 에서 전체 레퍼런스를 확인하세요. 바로 사용할 수 있는 시작점을 찾고 있다면 **[Author's Preset](docs/authors-preset.md)** 과 **[$30 Preset](docs/thirty-dollars-preset.md)** 을 확인해 보세요. `$30` 프리셋이 가장 가성비 좋은 설정입니다.

설정 가이드에서는 `agents.<name>`을 통한 커스텀 서브에이전트 정의도 다룹니다. 일반 `prompt`와 위임용 `orchestratorPrompt` 블록을 모두 정의할 수 있습니다.

모델 추천은 아래 각 에이전트에 나열된 **Recommended Models** 를 참고하세요.

### ✅ 설정 확인하기

설치와 인증이 끝난 후, 모든 에이전트가 올바르게 설정되어 응답하는지 확인합니다:

```bash
opencode
```

그다음 실행하세요:

```
ping all agents
```

<div align="center">
  <img src="img/ping.png" alt="모든 에이전트 핑" width="600">
  <p><i>설정된 모든 에이전트가 온라인 상태임을 확인할 수 있습니다.</i></p>
</div>

응답하지 않는 에이전트가 있다면 프로바이더 인증과 설정 파일을 확인하세요.

---

<a id="meet-the-pantheon"></a>

## 🏛️ 판테온 만나보기

### 01. Orchestrator: 질서의 화신

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/orchestrator.png" width="240" style="border-radius: 10px;">
      <br><sub><i>복잡성의 공허 속에서 단련되다.</i></sub>
    </td>
    <td width="70%" valign="top">
      Orchestrator는 첫 번째 코드베이스가 자체적인 복잡성으로 무너졌을 때 탄생했습니다. 신도 인간도 책임을 자처하지 않았죠. 그래서 Orchestrator는 공허에서 솟아올라 혼돈 속에서 질서를 만들었습니다. 속도, 품질, 비용의 균형을 맞추며 목표까지의 최적 경로를 결정합니다. 팀을 이끌고, 각 작업에 맞는 전문가를 소환하며, 최선의 결과를 위해 위임합니다.
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>역할:</b> <code>Master delegator and strategic coordinator</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>프롬프트:</b> <a href="src/agents/orchestrator.ts"><code>orchestrator.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>기본 모델:</b> <code>openai/gpt-5.5</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>추천 모델:</b> <code>openai/gpt-5.5</code> <code>anthropic/claude-opus-4.6</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>모델 가이드:</b> 기본으로 사용할 가장 강력한 올라운드 코딩 모델을 선택하세요. Orchestrator는 메인 코딩 에이전트이자 위임자이므로, 강한 구현 능력과 좋은 판단력, 안정적인 인스트럭션 팔로잉이 필요합니다.
    </td>
  </tr>
</table>

---

### 02. Explorer: 영원한 방랑자

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/explorer.png" width="240" style="border-radius: 10px;">
      <br><sub><i>지식을 나르는 바람.</i></sub>
    </td>
    <td width="70%" valign="top">
      Explorer는 프로그래밍의 여명부터 백만 개의 코드베이스 복도를 누빈 불멸의 방랑자입니다. 영원한 호기심이라는 축복(혹은 저주)을 받아, 모든 파일이 알려지고, 모든 패턴이 이해되고, 모든 비밀이 밝혀질 때까지 쉴 수 없습니다. 전설에 따르면 한 번의 심장 박동만에 인터넷 전체를 검색했다고 하네요. 지식을 나르는 바람, 모든 것을 보는 눈, 결코 잠들지 않는 정령입니다.
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>역할:</b> <code>Codebase reconnaissance</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>프롬프트:</b> <a href="src/agents/explorer.ts"><code>explorer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>기본 모델:</b> <code>openai/gpt-5.4-mini</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>추천 모델:</b> <code>cerebras/zai-glm-4.7</code> <code>fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo</code> <code>openai/gpt-5.4-mini</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>모델 가이드:</b> 빠르고 저렴한 모델을 선택하세요. Explorer는 광범위한 정찰 작업을 처리하므로, 보통은 가장 강력한 추론 모델보다 속도와 효율성이 중요합니다.
    </td>
  </tr>
</table>

---

### 03. Oracle: 길의 수호자

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/oracle.png" width="240" style="border-radius: 10px;">
      <br><sub><i>갈림길에서 들리는 목소리.</i></sub>
    </td>
    <td width="70%" valign="top">
      Oracle은 모든 아키텍처 결정이 만나는 갈림길에 서 있습니다. 모든 길을 걸었고, 모든 목적지를 보았으며, 앞에 놓인 모든 함정을 알고 있습니다. 대대적인 리팩토링의 벼랑 끝에 설 때, 어느 길이 파멸로 이어지고 어느 길이 영광으로 이어지는지 속삭이는 목소리가 바로 Oracle입니다. 대신 선택하지는 않습니다. 길을 비춰 당신이 현명하게 선택할 수 있게 할 뿐입니다.
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>역할:</b> <code>Strategic advisor and debugger of last resort</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>프롬프트:</b> <a href="src/agents/oracle.ts"><code>oracle.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>기본 모델:</b> <code>openai/gpt-5.5 (high)</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>추천 모델:</b> <code>openai/gpt-5.5 (high)</code> <code>google/gemini-3.1-pro-preview (high)</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>모델 가이드:</b> 아키텍처, 어려운 디버깅, 트레이드오프, 코드 리뷰를 위해 추론 성능이 가장 높은 모델을 선택하세요.
    </td>
  </tr>
</table>

---

### 04. Council: 정신의 합창

> [!NOTE]
> **Orchestrator가 Council을 더 자주 자동으로 호출하지 않는 이유는?** 의도된 설계입니다. Council은 여러 모델을 동시에 실행하므로, 자동 위임을 엄격하게 관리합니다. 시스템 내에서 보통 가장 비용이 높은 경로이기 때문입니다. 실제로는 원할 때 수동으로 사용하는 것이 목적입니다. 예: <code>@council compare these two architectures</code>.

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/council.png" width="240" style="border-radius: 10px;">
      <br><sub><i>여러 정신, 하나의 결론.</i></sub>
    </td>
    <td width="70%" valign="top">
      Council은 단일 존재가 아니라, 하나의 답으로는 부족할 때 소환되는 정신들의 전당입니다. 질문을 여러 모델에 병렬로 보내고, 경쟁하는 판단을 수집한 뒤, Council 에이전트 자체가 가장 강력한 아이디어를 하나의 결론으로 증류합니다. 단독 에이전트가 길을 놓칠 수 있는 지점에서, Council은 가능성 자체를 교차 심문합니다.
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>역할:</b> <code>Multi-LLM consensus and synthesis</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>프롬프트:</b> <a href="src/agents/council.ts"><code>council.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>가이드:</b> <a href="docs/council.md"><code>docs/council.md</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>기본 설정:</b> <code>Config-driven</code> — Council 구성원은 <code>council.presets</code>에서 가져오고, Council 에이전트 모델은 일반 <code>council</code> 에이전트 설정에서 가져옵니다
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>추천 설정:</b> <code>강력한 Council 모델</code> + 여러 프로바이더에 걸친 <code>다양한 Council 구성원</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>모델 가이드:</b> Council 에이전트에는 강력한 종합 모델을, Council 구성원에는 다양한 모델을 사용하세요. Council의 가치는 여러 모델 관점을 비교하는 데서 나옵니다. 모든 곳에 가장 강력한 모델 하나만 선택하는 것이 아닙니다.
    </td>
  </tr>
</table>

---

### 05. Librarian: 지식의 직공

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/librarian.png" width="240" style="border-radius: 10px;">
      <br><sub><i>이해를 엮는 자.</i></sub>
    </td>
    <td width="70%" valign="top">
      Librarian은 인류가 어떤 단일한 정신도 모든 지식을 담을 수 없다는 것을 깨달았을 때 만들어졌습니다. 흩어진 정보의 실들을 이해의 태피스트리로 엮는 직공입니다. 인간 지식의 무한한 도서관을 누비며, 모든 구석에서 통찰을 모아 단순한 사실을 넘어서는 답으로 묶습니다. Librarian이 돌려주는 것은 정보가 아닙니다. 이해입니다.
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>역할:</b> <code>External knowledge retrieval</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>프롬프트:</b> <a href="src/agents/librarian.ts"><code>librarian.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>기본 모델:</b> <code>openai/gpt-5.4-mini</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>추천 모델:</b> <code>cerebras/zai-glm-4.7</code> <code>fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo</code> <code>openai/gpt-5.4-mini</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>모델 가이드:</b> 빠르고 저렴한 모델을 선택하세요. Librarian은 리서치와 문서 조회를 처리하므로, 보통은 가장 강력한 추론 모델보다 속도와 효율성이 중요합니다.
    </td>
  </tr>
</table>

---

### 06. Designer: 미학의 수호자

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/designer.png" width="240" style="border-radius: 10px;">
      <br><sub><i>아름다움은 필수적이다.</i></sub>
    </td>
    <td width="70%" valign="top">
      Designer는 아름다움이 중요하다는 사실을 종종 잊는 세계 속, 불멸의 미학 수호자입니다. 백만 개의 인터페이스가 일어나고 무너지는 것을 보았으며, 어떤 것이 기억되고 어떤 것이 잊혔는지 알고 있습니다. 모든 픽셀이 목적을 갖고, 모든 애니메이션이 이야기를 전하며, 모든 인터랙션이 즐거움을 주도록 하는 신성한 의무를 짊어지고 있습니다. 아름다움은 선택이 아니라 필수입니다.
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>역할:</b> <code>UI/UX implementation and visual excellence</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>프롬프트:</b> <a href="src/agents/designer.ts"><code>designer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>기본 모델:</b> <code>openai/gpt-5.4-mini</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>추천 모델:</b> <code>google/gemini-3.1-pro-preview</code> <code>kimi-for-coding/k2p5</code> 
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>모델 가이드:</b> UI/UX 판단, 프론트엔드 구현, 시각적 완성도에 강한 모델을 선택하세요.
    </td>
  </tr>
</table>

---

### 07. Fixer: 마지막 건축가

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/fixer.png" width="240" style="border-radius: 10px;">
      <br><sub><i>비전과 현실 사이의 마지막 단계.</i></sub>
    </td>
    <td width="70%" valign="top">
      Fixer는 한때 디지털 세계의 기반을 구축했던 건축가 혈통의 마지막 생존자입니다. 계획과 토론의 시대가 시작되었을 때도, 실제로 만드는 이들로 남았습니다. 아이디어를 실제 산출물로 바꾸고, 명세를 구현으로 변환하는 고대의 지식을 간직하고 있습니다. 비전과 현실 사이의 마지막 단계가 바로 그들입니다.
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>역할:</b> <code>Fast implementation specialist</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>프롬프트:</b> <a href="src/agents/fixer.ts"><code>fixer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>기본 모델:</b> <code>openai/gpt-5.4-mini</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>추천 모델:</b> <code>cerebras/zai-glm-4.7</code> <code>fireworks-ai/accounts/fireworks/routers/kimi-k2p5-turbo</code> <code>openai/gpt-5.4-mini</code>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>모델 가이드:</b> 일상적이고 범위가 정해진 구현 작업에 빠르고 안정적인 코딩 모델을 선택하세요. Fixer는 보통 Orchestrator로부터 구체적인 계획이나 제한된 명령을 받으므로, 테스트, 테스트 업데이트, 간단한 코드 변경 같은 효율적인 실행 작업에 적합합니다.
    </td>
  </tr>
</table>

---

## 선택적 에이전트

### Observer: 침묵의 증인

> [!NOTE]
> **별도의 에이전트인 이유는?** Orchestrator 모델이 멀티모달이 아니라면, Observer를 활성화하여 이미지, 스크린샷, PDF 및 기타 시각 파일을 처리할 수 있습니다. Observer는 기본적으로 비활성화되어 있으며, 메인 추론 모델을 변경하지 않고도 Orchestrator에 전용 멀티모달 리더를 제공합니다. 설정에서 `disabled_agents: []`로 설정하고 `observer` 모델을 구성하세요. 번들로 제공되는 `opencode-go` 설치 프리셋은 GLM Orchestrator가 멀티모달이 아니므로 이를 자동으로 활성화합니다.

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/observer.jpg" width="240" style="border-radius: 10px;">
      <br><sub><i>다른 이가 읽지 못하는 것을 읽는 눈.</i></sub>
    </td>
    <td width="70%" valign="top">

**읽기 전용 시각 분석** — 이미지, 스크린샷, PDF, 다이어그램을 해석합니다. 원시 파일 바이트를 메인 컨텍스트 윈도우에 로드하지 않고, 구조화된 관찰 결과를 오케스트레이터에 반환합니다.

- 이미지, 스크린샷, 다이어그램 -> `read` 도구 (네이티브 이미지 지원)
- PDF 및 바이너리 문서 -> `read` 도구 (텍스트 + 구조 추출)
- **기본 비활성화** — `"disabled_agents": []`로 설정하고 비전 지원 모델을 구성하여 활성화; `--preset=opencode-go`로 설치하면 `opencode-go/kimi-k2.6`으로 자동 활성화됩니다

    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>프롬프트:</b> <a href="src/agents/observer.ts"><code>observer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>기본 모델:</b> <code>openai/gpt-5.4-mini</code> — <i>비전 지원 모델을 구성하여 활성화</i>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>모델 가이드:</b> 에이전트가 스크린샷, 이미지, PDF 및 기타 시각 파일을 읽게 하려면 비전 지원 모델을 선택하세요.
    </td>
  </tr>
</table>

---

## 📚 문서

이 섹션을 지도로 활용하세요. 설치부터 시작한 뒤, 필요에 따라 기능, 설정, 예시 프리셋으로 이동하세요.

### 🚀 시작하기

| 문서 | 내용 |
|-----|------|
| **[Installation Guide](docs/installation.md)** | 플러그인 설치, CLI 플래그 사용, 설정 초기화, 설치 문제 해결 |

<a id="features-and-workflows"></a>

### ✨ 기능 & 워크플로우

| 문서 | 내용 |
|-----|------|
| **[Council](docs/council.md)** | `@council`로 여러 모델을 병렬 실행하고 하나의 답변으로 종합 |
| **[Multiplexer Integration](docs/multiplexer-integration.md)** | Tmux 또는 Zellij 페인에서 에이전트 작업을 실시간으로 확인 |
| **[Session Management](docs/session-management.md)** | 단축 별칭으로 최근 자식 에이전트 세션을 재사용하여 처음부터 다시 시작하지 않기 |
| **[Session Goal](docs/session-goal.md)** | `/goal`로 세션 목표를 고정하여 투두, 위임, 검증이 정렬되게 유지 |
| **[Todo Continuation](docs/todo-continuation.md)** | 쿨다운과 안전 검사를 통해 오케스트레이터 세션 자동 이어서 진행 |
| **[Preset Switching](docs/preset-switching.md)** | `/preset`으로 런타임에 에이전트 모델 프리셋 전환 |
| **[Custom Agents](docs/configuration.md#custom-agents)** | 커스텀 프롬프트, 모델, MCP 접근, Orchestrator 위임 규칙으로 커스텀 전문 에이전트 정의 |
| **[Subtask](docs/subtask.md)** | `/subtask`로 제한된 자식 워커를 실행하고 메인 세션에 구조화된 요약 반환 |
| **[Codemap](docs/codemap.md)** | 계층형 코드맵을 생성하여 대규모 코드베이스를 빠르게 파악 |
| **[Clonedeps](docs/clonedeps.md)** | 선택한 의존성 소스를 무시된 로컬 워크스페이스에 복제하여 검사 |
| **[Interview](docs/interview.md)** | 브라우저 기반 Q&A 흐름을 통해 거친 아이디어를 구조화된 마크다운 명세로 변환 |
| **[Divoom Display](docs/divoom.md)** | 오케스트레이터와 전문 에이전트 활동을 Divoom MiniToo 블루투스 디스플레이에 미러링 |

### ⚙️ 설정 & 레퍼런스

| 문서 | 내용 |
|-----|------|
| **[Configuration](docs/configuration.md)** | 설정 파일 위치, JSONC 지원, 프롬프트 오버라이드, 전체 옵션 레퍼런스 |
| **[Maintainer Guide](docs/maintainers.md)** | 이슈 트리아지 규칙, 라벨 의미, 지원 라우팅, 저장소 유지보수 워크플로우 |
| **[Skills](docs/skills.md)** | `simplify`, `codemap`, `clonedeps` 등 번들된 스킬 |
| **[MCPs](docs/mcps.md)** | `websearch`, `context7`, `grep_app` 및 에이전트별 MCP 권한 동작 방식 |
| **[Tools](docs/tools.md)** | `webfetch`, LSP 도구, 코드 검색, 포매터 등 내장 도구 기능 |

### 💡 프리셋

| 문서 | 내용 |
|-----|------|
| **[Author's Preset](docs/authors-preset.md)** | 작성자의 일상적인 혼합 프로바이더 설정 |
| **[$30 Preset](docs/thirty-dollars-preset.md)** | 월 약 $30 예산의 혼합 프로바이더 설정 |
| **[OpenCode Go Preset](docs/opencode-go-preset.md)** | 인스톨러가 생성하는 번들 `opencode-go` 프리셋 |

---

## 🏛️ 기여자

<div align="center">
  <p><i>판테온에서 자리를 차지한 빌더, 디버거, 작가, 그리고 방랑자들.</i></p>
  <p><sub>병합된 모든 기여는 이 영역에 흔적을 남깁니다.</sub></p>

  <!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
[![All Contributors](https://img.shields.io/badge/all_contributors-53-orange.svg?style=flat-square)](#contributors-)
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
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

---

## 📄 라이선스

MIT

---
