<div align="center">
  <a href="https://github.com/alvinunreal/oh-my-opencode-slim/stargazers">
    <img src="img/v3-beta.webp" alt="انتشار نسخه Beta 3 از oh-my-opencode-slim" style="border-radius: 10px;">
  </a>
  <h3>✨ oh-my-opencode-slim ✨</h3>

  <p><i>هفت موجود افسانه‌ای از دل دنیای کد ظهور کرده‌اند؛ هرکدام استادی بی‌همتا در تخصص خود،<br>آماده‌اند تا به فرمان شما آشوب را به نظم تبدیل کنند و چیزهایی بسازند که روزی ناممکن به نظر می‌رسیدند.</i></p>

  <p><b>مجموعه Multi-Agent برای OpenCode</b> · ترکیب آزادانه مدل‌ها · واگذاری خودکار taskها</p>
  <p><sub>ساخته‌شده توسط <b>Boring Dystopia Development</b></sub></p>
  <p>
    <a href="https://boringdystopia.ai/"><img src="https://img.shields.io/badge/boringdystopia.ai-111111?style=for-the-badge&logo=vercel&logoColor=white" alt="boringdystopia.ai"></a>&nbsp;
    <a href="https://x.com/alvinunreal"><img src="https://img.shields.io/badge/X-@alvinunreal-000000?style=for-the-badge&logo=x&logoColor=white" alt="X @alvinunreal"></a>&nbsp;
    <a href="https://t.me/boringdystopiadevelopment"><img src="https://img.shields.io/badge/Telegram-Join%20channel-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram Join channel"></a>&nbsp;
  </p>

  <p>
    <a href="https://svgdiagram.ai"><img src="img/svgdiagram-logo.svg" alt="svgdiagram.ai" width="40" height="28" align="absmiddle"></a>&nbsp;
    <a href="https://svgdiagram.ai"><b>svgdiagram.ai</b></a> <sub>· یادداشت‌هایتان را به نمودارهای SVG تمیز و قابل‌ویرایش تبدیل کنید</sub>
  </p>

  <p>
    <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja-JP.md">日本語</a> | <a href="README.ko-KR.md">한국어</a> | <b>فارسی</b>
  </p>

  <p><sub>✦ ✦ ✦</sub></p>

</div>

## این Plugin چیست؟

افزونه oh-my-opencode-slim یک Plugin برای هماهنگ‌سازی و مدیریت Agentها در OpenCode است. این افزونه یک تیم داخلی از Agentهای تخصصی دارد که می‌توانند Codebase را بررسی کنند، مستندات به‌روز را پیدا کنند، معماری را بازبینی کنند، کارهای UI را انجام دهند و taskهای پیاده‌سازی با محدوده مشخص را زیر نظر Orchestrator اجرا کنند.

ایده اصلی ساده است: به‌جای اینکه یک مدل مجبور باشد همه‌چیز را انجام دهد، Plugin هر بخش از کار را به مناسب‌ترین Agent می‌سپارد تا بین **کیفیت، سرعت و هزینه** تعادل برقرار شود. Orchestrator گراف کار را برنامه‌ریزی می‌کند، Agentهای تخصصی را به‌صورت background task اجرا می‌کند و پیش از ادامه، نتایج آن‌ها را یکپارچه می‌کند.

### ✨ نکات برجسته

* **[هفت Agent تخصصی / Seven specialized agents](#meet-the-pantheon)** — شامل Orchestrator، Explorer،
  همچنین Oracle، Council، Librarian، Designer و Fixer است. هر بخش از کار به
  مناسب‌ترین Agent سپرده می‌شود و می‌توانید مدل‌های مختلف از Providerهای مختلف را با هم ترکیب کنید.
* **[هماهنگ‌سازی پس‌زمینه / Background orchestration](docs/background-orchestration.md)** — در این حالت
  عامل Orchestrator متخصص‌ها را به‌صورت background task اجرا و پیگیری می‌کند و
  پیش از ادامه، نتایج را یکپارچه می‌کند؛ اجرای موازی نیز به‌صورت پیش‌فرض فعال است.
* **[مهارت‌های همراه / Bundled skills](#skills)** — شامل workflowهای مبتنی بر Prompt مانند `deepwork`،
  همچنین `codemap`، `verification-planning` و `reflect` است که برای هر Agent قابل تخصیص هستند.
* **[شورای مدل‌ها / Council](docs/council.md)** — چند مدل را به‌صورت موازی روی یک
  سؤال اجرا می‌کند و با `@council` از نتایج یک پاسخ واحد می‌سازد.
* **[همراه میزکار / Companion](docs/companion.md)** — یک پنجره شناور اختیاری روی Desktop است
  که Agentهای فعال، از جمله متخصص‌های در حال اجرای موازی در پس‌زمینه، را نمایش می‌دهد.
* **[یکپارچه‌سازی Multiplexer / Multiplexer integration](docs/multiplexer-integration.md)** — امکان مشاهده کار Agentها را
  به‌صورت زنده در paneهای Tmux، Zellij، Herdr، cmux یا kitty فراهم می‌کند.
* **[تغییر Preset / Preset switching](docs/preset-switching.md)** — مدل‌های کل تیم را
  هنگام اجرا با `/preset` تغییر می‌دهد.
* **[ابزارهای هوشمند کد / Code intelligence tools](docs/tools.md)** — شامل ابزارهای LSP و جست‌وجوی آگاه از AST است
  و برای ۲۵ زبان، همراه با MCPهای داخلی برای مستندات و جست‌وجوی کد GitHub،
  امکانات لازم را در اختیار شما قرار می‌دهد.
* **[سفارشی‌سازی کامل / Fully customizable](docs/configuration.md)** — شامل Agentهای سفارشی و Prompt
  و همچنین override، دسترسی Skill/MCP برای هر Agent و
  [سفارشی‌سازی در سطح پروژه / Project-local customization](docs/project-local-customization.md) است.


### نظر کاربران

> «مدیریت taskها خیلی راحت از ۵/۱۰ به ۸ یا ۹/۱۰ رسید. Orchestrator،
> Fixerها و Explorerها را می‌فرستد و من همچنان می‌توانم در همان session با Orchestrator
> صحبت و برنامه‌ریزی کنم. تجربه کار حالا خیلی روان‌تر شده است.»
>
> \- `vipor_idk`

> «برای این نسخه Beta از omo-slim همه harnessهای قبلی‌ام را کنار گذاشتم و
> هیچ دلتنگشان نیستم. کار عالی است و به‌نظر من همه‌چیز در مسیر درستی پیش می‌رود.»
>
> \- `stephanschielke`


> «من omo-slim را دوست دارم و دیگر نمی‌توانم اجرای OpenCode بدون آن را تصور کنم. اینکه
می‌توانم ترکیبی Frankenstein‌وار از مدل‌ها بسازم فوق‌العاده است... این setup را واقعاً قدرتمند می‌کند.»
>
> \- `Capital-One3039`



> «این پلاگین workflow من را به‌شکل محسوسی بهتر کرده است... حالا خیلی
> روان کار می‌کند و واقعاً دوستش دارم.»
>
> \- `xenstar1`


### راه‌اندازی سریع

این Prompt را کپی کنید و در LLM Agent خود (Claude Code، AmpCode، Cursor و غیره) قرار دهید:


```
Install and configure oh-my-opencode-slim: https://raw.githubusercontent.com/alvinunreal/oh-my-opencode-slim/refs/heads/master/README.md
```


### نصب دستی

```bash
bunx oh-my-opencode-slim@latest install
```

رابط خط فرمان منتشرشده با Node سازگار است؛ بنابراین اگر Bun را نصب ندارید، می‌توانید از `npx` هم استفاده کنید:

```bash
npx oh-my-opencode-slim@latest install
```

### اجرا از شاخه Master

اگر آخرین کد، رفع باگ آسان‌تر یا یک setup محلی برای
توسعه و مشارکت می‌خواهید، از این روش استفاده کنید:

```bash
git clone https://github.com/alvinunreal/oh-my-opencode-slim.git ~/repos/oh-my-opencode-slim
cd ~/repos/oh-my-opencode-slim
bun install
bun run build
bun dist/cli/index.js install
```

نصب‌کننده مسیر repository محلی را به آرایه `plugin` در `~/.config/opencode/opencode.json` اضافه می‌کند تا OpenCode افزونه را مستقیماً از همان پوشه بارگذاری کند. برای به‌روزرسانی‌های بعدی:

```bash
cd ~/repos/oh-my-opencode-slim
git pull
bun install
bun run build
```

### راه‌اندازی اولیه

نصب‌کننده هر دو Preset مربوط به OpenAI و OpenCode Go را ایجاد می‌کند و به‌صورت پیش‌فرض OpenAI فعال است.

> [!TIP]
> مدل‌ها و Agentها را متناسب با workflow خود تنظیم کنید. مقادیر پیش‌فرض فقط
> نقطه شروع هستند؛ Plugin برای انعطاف‌پذیری و سفارشی‌سازی گسترده طراحی شده است.

برای فعال‌کردن OpenCode Go هنگام نصب، `bunx oh-my-opencode-slim@latest install --preset=opencode-go` را اجرا کنید یا بعد از نصب نام Preset پیش‌فرض را در `~/.config/opencode/oh-my-opencode-slim.json` تغییر دهید.

سپس:

1. **اگر هنوز وارد Providerهای موردنظر نشده‌اید، وارد شوید**:

   ```bash
   opencode auth login
   ```
2. **فهرست مدل‌هایی را که OpenCode می‌بیند refresh و نمایش دهید**:

   ```bash
   opencode models --refresh
   ```
3. **فایل تنظیمات Plugin را باز کنید**: `~/.config/opencode/oh-my-opencode-slim.json`

4. **مدل موردنظر برای هر Agent را تنظیم کنید**

> [!TIP]
> توصیه می‌شود نحوه کار background orchestration را بشناسید. **[Prompt مربوط به Orchestrator](https://github.com/alvinunreal/oh-my-opencode-slim/blob/master/src/agents/orchestrator.ts#L28)** شامل قوانین scheduler، منطق routing متخصص‌ها و thresholdهای واگذاری کار به Agentهای پس‌زمینه است. همیشه می‌توانید با `@agentName <task>` یک subagent را به‌صورت دستی فراخوانی کنید.

> [!TIP]
> چون Agentهای پس‌زمینه حالا workflow پیش‌فرض هستند، **به‌شدت توصیه می‌شود** **[Multiplexer Integration](docs/multiplexer-integration.md)** را فعال و تنظیم کنید. این قابلیت هر Agent را به‌صورت خودکار در یک pane اختصاصی از Tmux، Zellij، Herdr، cmux یا kitty باز می‌کند تا هم‌زمان با ادامه هماهنگی session توسط Orchestrator، کار متخصص‌ها را زنده ببینید.

تنظیمات پیش‌فرض تولیدشده شامل هر دو Preset یعنی `openai` و `opencode-go` است.

```jsonc
{
  "$schema": "https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json",
  "preset": "openai",
  "presets": {
    "openai": {
      "orchestrator": { "model": "openai/gpt-6-sol", "variant": "high", "skills": ["*"], "mcps": ["*", "!context7"] },
      "oracle": { "model": "openai/gpt-6-astra", "variant": "high", "skills": ["simplify"], "mcps": [] },
      "librarian": { "model": "openai/gpt-6-luna", "variant": "low", "skills": [], "mcps": ["context7", "gh_grep"] },
      "explorer": { "model": "openai/gpt-6-luna", "variant": "low", "skills": [], "mcps": [] },
      "designer": { "model": "openai/gpt-6-luna", "variant": "medium", "skills": [], "mcps": [] },
      "fixer": { "model": "openai/gpt-6-luna", "variant": "high", "skills": [], "mcps": [] }
    }
  }
}
```

### مستندات Presetها

پیشنهاد می‌شود Presetها را بیشتر به‌عنوان راهنما در نظر بگیرید، چون ممکن است همیشه کاملاً به‌روز نباشند.

<ul dir="rtl" align="right">
  <li><strong><a href="docs/openai-preset.md">OpenAI Preset</a></strong> — Preset پیش‌فرضی که همه Agentها را با مدل‌های OpenAI اجرا می‌کند.</li>
  <li><strong><a href="docs/opencode-go-preset.md">OpenCode Go Preset</a></strong> — Agentها را با مدل‌های OpenCode Go اجرا می‌کند و چون مدل Orchestrator آن multimodal نیست، Agent مربوط به Observer را برای تحلیل تصویری فعال می‌کند.</li>
  <li><strong><a href="docs/authors-preset.md">Author's Preset</a></strong> — همان تنظیماتی است که نویسنده در استفاده روزمره به کار می‌برد و شامل Skillهای شخص ثالث نیز می‌شود.</li>
  <li><strong><a href="docs/thirty-dollars-preset.md">$30 Preset</a></strong> — یک setup چند-Provider مبتنی بر Codex Plus و GitHub Copilot Pro با هزینه تقریبی ۳۰ دلار در ماه است.</li>
</ul>

### برای Providerهای جایگزین

برای استفاده از Providerهای سفارشی یا ستاپ multi-Provider، مرجع کامل **[Configuration](docs/configuration.md)** را ببینید.

### ✅ بررسی setup

پس از نصب و authentication، بررسی کنید همه Agentها درست تنظیم شده‌اند و پاسخ می‌دهند:

```bash
opencode
```

سپس اجرا کنید:

```
ping all agents
```

<div align="center">
  <img src="img/ping.png" alt="بررسی پاسخ‌گویی همه Agentها" width="600">
  <p dir="rtl" align="center"><i>تأیید اینکه همه Agentهای پیکربندی‌شده online و آماده هستند.</i></p>
</div>

اگر Agentی پاسخ نمی‌دهد، authentication مربوط به Provider و فایل تنظیمات را بررسی کنید.

---

<a id="meet-the-pantheon"></a>

## 🏛️ آشنایی با Pantheon
> مجمع خدایان

<h3 dir="rtl" align="right">01. Orchestrator: مظهر نظم</h3>

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/orchestrator.jpg" width="240" style="border-radius: 10px;">
      <br><sub><i>.در خلأ پیچیدگی ساخته شده است</i></sub>
    </td>
    <td width="70%" valign="top" dir="rtl" align="right">
      عامل Orchestrator زمانی پدید آمد که نخستین Codebase زیر بار پیچیدگی خودش فرو ریخت. نه خدایان و نه انسان‌ها حاضر نبودند مسئولیت این آشوب را بپذیرند؛ پس Orchestrator از دل خلأ برخاست تا به بی‌نظمی، نظم ببخشد.

برای رسیدن به هر هدف، با درنظرگرفتن سرعت، کیفیت و هزینه بهترین مسیر را انتخاب می‌کند. تیم را هدایت می‌کند، متخصص مناسب هر task را به کار می‌گیرد و وظایف را میان آن‌ها تقسیم می‌کند تا بهترین نتیجه ممکن به دست آید.
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>نقش:</b> <code>واگذارکننده اصلی و هماهنگ‌کننده راهبردی</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>Prompt:</b> <a href="src/agents/orchestrator.ts"><code>orchestrator.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>مدل پیش‌فرض:</b> <code>openai/gpt-6-sol (medium)</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>مدل‌های پیشنهادی:</b> <code>claude-fable-5</code> <code>claude-opus-4-8</code> <code>glm-5.2</code> <code>gpt-6-sol</code> <code>mimo-v2.5</code> <code>minimax-m3</code> <code>qwen3.7-plus</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>راهنمای انتخاب مدل:</b> برای انتخاب مدل، قوی‌ترین مدل خود در planning و تصمیم‌گیری را در نظر بگیرید. Orchestrator مدیر workflow است: برنامه‌ریزی می‌کند، متخصص‌های پس‌زمینه را زمان‌بندی می‌کند، نتایج را یکپارچه می‌کند و خروجی را بررسی می‌کند. بنابراین بیش از توان پردازشی خام، به پیروی دقیق از دستورها و قضاوت فنی سطح‌بالا نیاز دارد.
    </td>
  </tr>
</table>

---

<h3 dir="rtl" align="right">02. Explorer: کاوشگر جاودانه</h3>

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/explorer.jpg" width="240" style="border-radius: 10px;">
      <br><sub><i>.بادی که دانش را با خود می‌آورد</i></sub>
    </td>
    <td width="70%" valign="top" dir="rtl" align="right">
      عامل Explorer کاوشگری جاودانه است که از همان روزهای نخست برنامه‌نویسی، میلیون‌ها Codebase را کاوش کرده است. کنجکاوی بی‌پایانش نمی‌گذارد تا وقتی همه فایل‌ها را پیدا نکرده، الگوها را نفهمیده و رازهای پنهان را کشف نکرده، آرام بگیرد.

افسانه‌ها می‌گویند زمانی تمام اینترنت را در یک چشم‌برهم‌زدن جست‌وجو کرده است. او بادی است که دانش را با خود می‌آورد، چشمی که هیچ چیز از آن پنهان نمی‌ماند و روحی که هرگز از جست‌وجو خسته نمی‌شود.
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>نقش:</b> <code>شناسایی و بررسی Codebase</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>Prompt:</b> <a href="src/agents/explorer.ts"><code>explorer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>مدل پیش‌فرض:</b> <code>openai/gpt-6-luna</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>مدل‌های پیشنهادی:</b> <code>deepseek-v4-flash</code> <code>gpt-5.3-codex</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>راهنمای انتخاب مدل:</b> برای انتخاب مدل، یک مدل سریع و کم‌هزینه مناسب‌تر است. Explorer وظیفه بررسی و جست‌وجوی گسترده را بر عهده دارد، بنابراین معمولاً سرعت و بهره‌وری از استفاده از قوی‌ترین مدل reasoning اهمیت بیشتری دارد.
    </td>
  </tr>
</table>

---

<h3 dir="rtl" align="right">03. Oracle: نگهبان مسیرها</h3>

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/oracle.jpg" width="240" style="border-radius: 10px;">
      <br><sub><i>.صدایی در دوراهی‌ها</i></sub>
    </td>
    <td width="70%" valign="top" dir="rtl" align="right">
      عامل Oracle بر سر دوراهی هر تصمیم معماری ایستاده است. همه راه‌ها را پیموده، همه مقصدها را دیده و همه تله‌های پیش رو را می‌شناسد. وقتی در آستانه یک refactor بزرگ قرار دارید، همان صدایی است که نشان می‌دهد کدام مسیر به شکست و کدام به موفقیت می‌رسد. به‌جای شما تصمیم نمی‌گیرد؛ مسیرها را روشن می‌کند تا بتوانید آگاهانه انتخاب کنید.
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>نقش:</b> <code>مشاور راهبردی و آخرین گزینه برای debugging</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>Prompt:</b> <a href="src/agents/oracle.ts"><code>oracle.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>مدل پیش‌فرض:</b> <code>openai/gpt-6-astra (high)</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>مدل‌های پیشنهادی:</b> <code>claude-fable-5</code> <code>claude-opus-4-8</code> <code>deepseek-v4-pro</code> <code>glm-5.2</code> <code>gpt-6-astra</code> <code>qwen3.7-max</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>راهنمای انتخاب مدل:</b> برای معماری، debugging دشوار، trade-offها و code review، قوی‌ترین مدل high-reasoning خود را انتخاب کنید.
    </td>
  </tr>
</table>

---

<h3 dir="rtl" align="right">04. Council: هم‌اندیشی ذهن‌ها</h3>

> [!NOTE]
> **چرا Orchestrator بیشتر به‌صورت خودکار Council را فراخوانی نمی‌کند؟** این رفتار عمدی است. Council چند مدل را هم‌زمان اجرا می‌کند، بنابراین delegation خودکار آن سخت‌گیرانه نگه داشته شده چون معمولاً پرهزینه‌ترین مسیر در سیستم است. در عمل، ذکر واژه‌های محرک مانند `council`، `@council`، `consensus` یا `共识` در پیام شما، رویه Council Mode را به آن نوبت تزریق می‌کند و Orchestrator همه صندلی‌های councillor را به‌صورت موازی اعزام می‌کند؛ برای مثال: <code>run a council on these two architectures</code>. رویه کامل هرگز به‌صورت ایستا حمل نمی‌شود: نشست‌هایی که Council نمی‌خواهند هیچ توکنی برای آن پرداخت نمی‌کنند، و تزریق را می‌توان با <code>disabled_hooks: ["council-inject"]</code> به‌طور کامل خاموش کرد.

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/council.jpg" width="240" style="border-radius: 10px;">
      <br><sub><i>.ذهن‌های بسیار، یک نتیجه</i></sub>
    </td>
    <td width="70%" valign="top" dir="rtl" align="right">
      عامل Council یک ذهن واحد نیست؛ مجمعی از چند ذهن است که وقتی یک پاسخ به‌تنهایی کافی نباشد، وارد عمل می‌شود. سؤال را هم‌زمان در اختیار چند مدل قرار می‌دهد، دیدگاه‌های مختلف آن‌ها را جمع می‌کند و در نهایت بهترین ایده‌ها را در یک پاسخ واحد کنار هم می‌گذارد.

جایی که یک Agent ممکن است بخشی از مسئله را نبیند، Council آن را از چند زاویه بررسی می‌کند تا تصویر کامل‌تری به دست آید.
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>نقش:</b> <code>اجماع و ترکیب نتایج چند LLM</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>Prompt:</b> <a href="src/agents/council.ts"><code>council.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>راهنما:</b> <a href="docs/council.md"><code>docs/council.md</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>Setup پیش‌فرض:</b> <code>مبتنی بر تنظیمات</code> - councillorها از <code>council.presets</code> می‌آیند و مدل Agent مربوط به Council از تنظیمات معمول Agent <code>council</code> گرفته می‌شود
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>Setup پیشنهادی:</b> <code>مدل قوی برای Council</code> + <code>councillorهای متنوع</code> از Providerهای مختلف
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>راهنمای انتخاب مدل:</b> برای انتخاب مدل، بهتر است برای Agent مربوط به Council از یک مدل قدرتمند در synthesis و برای councillorها از مدل‌های متنوع استفاده کنید. ارزش Council در مقایسه دیدگاه مدل‌های مختلف است، نه صرفاً استفاده از یک مدل بسیار قدرتمند برای همه‌چیز.
    </td>
  </tr>
</table>

---

<h3 dir="rtl" align="right">05. Librarian: پیونددهنده دانش</h3>

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/librarian.jpg" width="240" style="border-radius: 10px;">
      <br><sub><i>.جوینده‌ی فهم</i></sub>
    </td>
    <td width="70%" valign="top" dir="rtl" align="right">
      Librarian زمانی شکل گرفت که انسان فهمید هیچ ذهنی به‌تنهایی نمی‌تواند همه دانش را در خود نگه دارد. او رشته‌های پراکنده اطلاعات را به تصویری یکپارچه از فهم پیوند می‌دهد. در کتابخانه بی‌پایان دانش بشر می‌گردد، از هر گوشه insight جمع می‌کند و آن‌ها را به پاسخ‌هایی فراتر از مجموعه‌ای از factها تبدیل می‌کند. چیزی که بازمی‌گرداند صرفاً اطلاعات نیست؛ فهم است.
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>نقش:</b> <code>بازیابی دانش خارجی</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>Prompt:</b> <a href="src/agents/librarian.ts"><code>librarian.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>مدل پیش‌فرض:</b> <code>openai/gpt-6-luna</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>مدل‌های پیشنهادی:</b> <code>deepseek-v4-flash</code> <code>gpt-5.3-codex</code> <code>mimo-v2.5</code> <code>minimax-m2.7</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>راهنمای انتخاب مدل:</b> یک مدل سریع و کم‌هزینه انتخاب کنید. Librarian مسئول research و جست‌وجوی مستندات است، بنابراین معمولاً سرعت و بهره‌وری مهم‌تر از استفاده از قوی‌ترین مدل reasoning شماست.
    </td>
  </tr>
</table>

---

<h3 dir="rtl" align="right">06. Designer: معمار زیبایی</h3>

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/designer.jpg" width="240" style="border-radius: 10px;">
      <br><sub><i>.زیبایی ضروری است</i></sub>
    </td>
    <td width="70%" valign="top" dir="rtl" align="right">
      Designer نگهبانی جاودانه برای زیبایی در جهانی است که اغلب فراموش می‌کند زیبایی اهمیت دارد. ظهور و سقوط میلیون‌ها interface را دیده و به یاد دارد کدام‌ها ماندگار شدند و کدام‌ها فراموش. وظیفه‌اش این است که هر pixel هدفی داشته باشد، هر animation داستانی بگوید و هر interaction دلپذیر باشد. زیبایی اختیاری نیست؛ ضروری است.
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>نقش:</b> <code>پیاده‌سازی UI/UX و کیفیت بصری</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>Prompt:</b> <a href="src/agents/designer.ts"><code>designer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>مدل پیش‌فرض:</b> <code>openai/gpt-6-luna</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>مدل‌های پیشنهادی:</b> <code>gemini-3.5-flash</code> <code>kimi-k2.7-code</code> <code>minimax-m3</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>راهنمای انتخاب مدل:</b> مدلی انتخاب کنید که در قضاوت UI/UX، پیاده‌سازی frontend و پرداخت بصری قوی باشد.
    </td>
  </tr>
</table>

---

<h3 dir="rtl" align="right">07. Fixer: آخرین سازنده</h3>

<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/fixer.jpg" width="240" style="border-radius: 10px;">
      <br><sub><i>.آخرین گام میان تصور و واقعیت</i></sub>
    </td>
    <td width="70%" valign="top" dir="rtl" align="right">
      Fixer آخرین بازمانده از تبار سازندگانی است که زمانی پایه‌های دنیای دیجیتال را بنا کردند. وقتی عصر planning و بحث آغاز شد، آن‌ها ماندند؛ کسانی که واقعاً می‌سازند. دانشی کهن برای تبدیل فکر به محصول و specification به implementation با خود دارند. آن‌ها آخرین گام میان تصور و واقعیت‌اند.
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>نقش:</b> <code>متخصص پیاده‌سازی سریع</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>Prompt:</b> <a href="src/agents/fixer.ts"><code>fixer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>مدل پیش‌فرض:</b> <code>openai/gpt-6-luna</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>مدل‌های پیشنهادی:</b> <code>claude-sonnet-4-6</code> <code>deepseek-v4-flash</code> <code>gpt-6-luna</code> <code>kimi-k2.7-code</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>راهنمای انتخاب مدل:</b> برای کارهای پیاده‌سازی با محدوده مشخص، یک مدل coding قابل‌اعتماد انتخاب کنید. Fixer یک plan مشخص یا دستورهای محدود و روشن از Orchestrator می‌گیرد، بنابراین جای مناسبی برای taskهای اجرایی کارآمد و تغییرات مستقیم کد است.
    </td>
  </tr>
</table>

---

<h2 dir="rtl" align="right">Agentهای اختیاری</h2>

<h3 dir="rtl" align="right">Observer: شاهد خاموش</h3>

> [!NOTE]
> **چرا یک Agent جداگانه؟** اگر مدل Orchestrator شما قابلیت multimodal ندارد، می‌توانید Observer را برای پردازش تصویرها، اسکرین‌شات‌ها و فایل‌های تصویری فعال کنید. Observer به‌صورت پیش‌فرض غیرفعال است و بدون اینکه لازم باشد مدل اصلی Orchestrator را تغییر دهید، یک Agent جداگانه برای تحلیل محتوای تصویری در اختیار آن قرار می‌دهد. برای فعال‌کردنش، `observer` را به یک مدل مناسب متصل کنید و `disabled_agents` را طوری تنظیم کنید که Observer غیرفعال نباشد. در Preset مربوط به `opencode-go` این تنظیم به‌صورت خودکار انجام می‌شود، چون مدل GLM مورد استفاده برای Orchestrator قابلیت multimodal ندارد. اگر `image_routing` را مشخص نکنید، رفتار پیش‌فرض حفظ می‌شود. با `image_routing: "auto"` فایل‌های تصویری در صورت فعال بودن Observer به آن ارسال می‌شوند؛ اگر می‌خواهید همیشه مستقیماً به Orchestrator بروند، مقدار آن را روی `"direct"` قرار دهید.


<table>
  <tr>
    <td width="30%" align="center" valign="top">
      <img src="img/observer.jpg" width="240" style="border-radius: 10px;">
      <br><sub><i>.چشمی که آنچه دیگران نمی‌توانند بخوانند، می‌خواند</i></sub>
    </td>
    <td width="70%" valign="top" dir="rtl" align="right">

**تحلیل محتوای تصویری** — تصویرها، اسکرین‌شات‌ها، PDFها و نمودارها را بررسی می‌کند و بدون وارد کردن داده خام فایل‌ها به context اصلی، نتایج ساختاریافته را به Orchestrator برمی‌گرداند.

- تصویرها، اسکرین‌شات‌ها و نمودارها → ابزار `read` با پشتیبانی مستقیم از تصویر
- PDFها و فایل‌های باینری → ابزار `read` برای استخراج متن و ساختار
- **به‌صورت پیش‌فرض غیرفعال است.** برای فعال‌کردن Observer، مقدار `disabled_agents` را روی `[]` قرار دهید و یک مدل دارای قابلیت پردازش تصویر برای آن تنظیم کنید. نصب با `--preset=opencode-go` این کار را به‌صورت خودکار با مدل `opencode-go/mimo-v2.5` انجام می‌دهد.

وقتی Observer فعال باشد، فایل‌های تصویری پیوست‌شده به‌صورت پیش‌فرض به آن هدایت می‌شوند. اگر می‌خواهید این فایل‌ها مستقیماً به Orchestrator ارسال شوند، مقدار `image_routing` را روی `"direct"` قرار دهید.

    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>Prompt:</b> <a href="src/agents/observer.ts"><code>observer.ts</code></a>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>مدل پیش‌فرض:</b> <code>openai/gpt-6-luna</code> - <i>برای فعال‌کردن، یک مدل vision-capable تنظیم کنید</i>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>مدل‌های پیشنهادی:</b> <code>mimo-v2.5</code> <code>qwen3.5-plus</code>
    </td>
  </tr>
  <tr>
    <td colspan="2" dir="rtl" align="right">
      <b>راهنمای انتخاب مدل:</b> اگر می‌خواهید Agent بتواند screenshot، تصویر، PDF و فایل‌های تصویری دیگر را بخواند، یک مدل vision-capable انتخاب کنید.
    </td>
  </tr>
</table>

---

<a id="skills"></a>

<h2 dir="rtl" align="right">🧩 Skillها</h2>

<p dir="rtl" align="right">
Skillها مجموعه‌ای از دستورهای مبتنی بر Prompt هستند که به system prompt یک Agent تزریق می‌شوند تا
تصمیم‌گیری، workflow و استفاده از ابزارها را هدایت کنند. برخلاف MCPها که سرورهای در حال اجرا هستند،
یک Skill هیچ process جداگانه‌ای اجرا نمی‌کند؛ بلکه playbook متمرکزی است که Agent
هر زمان task مناسب باشد آن را فعال می‌کند. Installer هشت Skill را همراه Plugin نصب می‌کند و در
auto-updateهای Plugin آن‌ها را به‌روز نگه می‌دارد؛ customizationهای محلی حفظ می‌شوند.
</p>

> [!TIP]
> برای کنارگذاشتن customizationهای محلی Skillهای همراه و دریافت updateهای package، اجرا کنید:
> `bunx oh-my-opencode-slim install --skills=force`. این دستور عمداً Skillهای همراه نصب‌شده را
> با نسخه‌های موجود در package جایگزین می‌کند.

<table>
  <tr>
    <th>Skill</th>
    <th dir="rtl" align="right">کاربرد</th>
    <th>Agent پیش‌فرض</th>
    <th>نحوه فراخوانی</th>
  </tr>
  <tr>
    <td align="center"><img src="img/skills/codemap.webp" width="120" alt="خروجی Codemap"><br><a href="src/skills/codemap/SKILL.md"><code>codemap</code></a></td>
    <td dir="rtl" align="right">نقشه سلسله‌مراتبی repository تا Agentها بدون خواندن دوباره همه‌چیز Codebase را درک کنند</td>
    <td><code>orchestrator</code></td>
    <td><code>run codemap</code></td>
  </tr>
  <tr>
    <td align="center"><img src="img/skills/deepwork.webp" width="120" alt="خروجی Deepwork"><br><a href="src/skills/deepwork/SKILL.md"><code>deepwork</code></a></td>
    <td dir="rtl" align="right">یک workflow ساخت‌یافته برای sessionهای coding بزرگ، پرریسک و چندمرحله‌ای همراه با gateهای review</td>
    <td><code>orchestrator</code></td>
    <td><code>/deepwork &lt;task&gt;</code></td>
  </tr>
  <tr>
    <td align="center"><img src="img/skills/verification-planning.webp" width="120" alt="خروجی Verification Planning"><br><a href="src/skills/verification-planning/SKILL.md"><code>verification-planning</code></a></td>
    <td dir="rtl" align="right">پیش از تغییرات غیرساده، یک مسیر evidence متناسب با پروژه برنامه‌ریزی می‌کند</td>
    <td><code>orchestrator</code></td>
    <td>خودکار، پیش از کارهای غیرساده</td>
  </tr>
  <tr>
    <td align="center"><img src="img/skills/simplify.webp" width="120" alt="خروجی Simplify"><br><a href="src/skills/simplify/SKILL.md"><code>simplify</code></a></td>
    <td dir="rtl" align="right">ساده‌سازی با حفظ رفتار برای خوانایی و maintainability بهتر</td>
    <td><code>oracle</code></td>
    <td>درخواست ساده‌سازی یا هنگام review</td>
  </tr>
  <tr>
    <td align="center"><img src="img/skills/worktrees.webp" width="120" alt="خروجی Worktrees"><br><a href="src/skills/worktrees/SKILL.md"><code>worktrees</code></a></td>
    <td dir="rtl" align="right">برای کارهای پرریسک یا موازی، Git worktree محیطی امن و ایزوله برای coding فراهم می‌کند</td>
    <td><code>orchestrator</code></td>
    <td><code>work in a worktree</code></td>
  </tr>
  <tr>
    <td align="center"><img src="img/skills/clonedeps.webp" width="120" alt="خروجی Clonedeps"><br><a href="src/skills/clonedeps/SKILL.md"><code>clonedeps</code></a></td>
    <td dir="rtl" align="right">وابستگی‌های source را به‌صورت local clone می‌کند تا Agentها بتوانند internals کتابخانه را بررسی کنند</td>
    <td><code>orchestrator</code></td>
    <td><code>clone dependencies</code></td>
  </tr>
  <tr>
    <td align="center"><img src="img/skills/reflect.webp" width="120" alt="خروجی Reflect"><br><a href="src/skills/reflect/SKILL.md"><code>reflect</code></a></td>
    <td dir="rtl" align="right">اصطکاک‌های تکراری workflow را به Skill، Agent یا config قابل استفاده مجدد تبدیل می‌کند</td>
    <td><code>orchestrator</code></td>
    <td><code>/reflect</code></td>
  </tr>
  <tr>
    <td align="center"><img src="img/skills/oh-my-opencode-slim.webp" width="120" alt="خروجی oh-my-opencode-slim"><br><a href="src/skills/oh-my-opencode-slim/SKILL.md"><code>oh-my-opencode-slim</code></a></td>
    <td dir="rtl" align="right">خود Plugin را تنظیم و با ایمنی بهبود می‌دهد</td>
    <td><code>orchestrator</code></td>
    <td>درخواست برای بهینه‌سازی setup</td>
  </tr>
</table>

تخصیص Skill در واقع اعطای permission است؛ یک Agent فقط Skillهایی را می‌تواند فعال کند که
به آن داده شده‌اند. آن‌ها را برای هر Agent با آرایه `skills` در
`~/.config/opencode/oh-my-opencode-slim.json` تنظیم کنید: یک فهرست صریح، `"*"` برای
همه Skillها یا `"!skill-name"` برای منع یک Skill.

مستندات کامل را در **[Skills](docs/skills.md)** ببینید، یا نمای تصویری
آن را در
**[ohmyopencodeslim.com/skills](https://ohmyopencodeslim.com/skills)** مشاهده کنید.

---

<a id="companion"></a>

<h2 dir="rtl" align="right">🖥️ Companion (همراهِ میزکار)</h2>

این پنجره شناور (Companion) اختیاری است، status زنده فعالیت Agentها را روی Desktop
نمایش می‌دهد. state فعلی session و Agentهای فعال را نشان می‌دهد تا
پیگیری کارهای پس‌زمینه در یک نگاه ساده‌تر باشد.

<div align="center">
  <img src="img/companion.gif" alt="Companion در حال نمایش Agentهای فعال" width="600">
  <p dir="rtl"><i>Companion بصری در پایین سمت چپ.</i></p>
</div>

در نصب interactive، Installer می‌پرسد آیا Companion فعال شود یا نه و
مقدار پیش‌فرض `no` است. برای automation، آن را صریحاً با این دستور فعال کنید:

```bash
bunx oh-my-opencode-slim@latest install --companion=yes
```

برای تنظیمات، موقعیت‌ها، اندازه‌ها و جزئیات نصب، **[Companion](docs/companion.md)** را
ببینید.

---

## 📚 مستندات

از این بخش مثل یک نقشه استفاده کنید: از نصب شروع کنید و سپس بسته به نیازتان به featureها، تنظیمات یا Presetهای نمونه بروید.

<a id="features-and-workflows"></a>

<h3 dir="rtl" align="right">✨ قابلیت‌ها و Workflow</h3>

<table>
  <tr>
    <th>سند</th>
    <th dir="rtl" align="right">چه چیزی را پوشش می‌دهد</th>
  </tr>
  <tr>
    <td><strong><a href="docs/council.md">Council</a></strong></td>
    <td dir="rtl" align="right">چند مدل را موازی اجرا می‌کند و با <code>@council</code> یک پاسخ واحد می‌سازد</td>
  </tr>
  <tr>
    <td dir="rtl" align="right"><strong><a href="docs/configuration.md#custom-agents">Agentهای سفارشی</a></strong></td>
    <td dir="rtl" align="right">متخصص‌های خود را با Prompt، مدل، دسترسی MCP و قوانین delegation برای Orchestrator تعریف کنید</td>
  </tr>
  <tr>
    <td><strong><a href="docs/acp-agents.md">ACP Agents</a></strong></td>
    <td dir="rtl" align="right">برای اتصال Agentهای خارجی سازگار با ACP مانند Claude Code ACP یا Gemini ACP، از آن‌ها به‌عنوان subagentهای قابل delegation استفاده کنید</td>
  </tr>
  <tr>
    <td><strong><a href="docs/multiplexer-integration.md">Multiplexer Integration</a></strong></td>
    <td dir="rtl" align="right">کار Agentها را به‌صورت زنده در paneهای Tmux، Zellij، Herdr، cmux یا kitty ببینید</td>
  </tr>
  <tr>
    <td><strong><a href="docs/codemap.md">Codemap</a></strong></td>
    <td dir="rtl" align="right">برای درک سریع‌تر Codebaseهای بزرگ، codemapهای سلسله‌مراتبی تولید کنید</td>
  </tr>
  <tr>
    <td><strong><a href="docs/clonedeps.md">Clonedeps</a></strong></td>
    <td dir="rtl" align="right">وابستگی‌های source انتخاب‌شده را برای بررسی در یک workspace محلیِ ignore‌شده clone کنید</td>
  </tr>
  <tr>
    <td><strong><a href="docs/worktrees.md">Worktrees</a></strong></td>
    <td dir="rtl" align="right">از laneهای <code>.slim/worktrees/</code> برای coding ایزوله، موازی یا پرریسک استفاده کنید</td>
  </tr>
  <tr>
    <td dir="rtl" align="right"><strong><a href="docs/preset-switching.md">تغییر Preset</a></strong></td>
    <td dir="rtl" align="right">برای تغییر Preset مدل‌های Agent هنگام اجرا، از <code>/preset</code> استفاده کنید</td>
  </tr>
  <tr>
    <td><strong><a href="docs/interview.md">Interview</a></strong></td>
    <td dir="rtl" align="right">ایده‌های اولیه را از طریق یک جریان پرسش‌وپاسخ مرورگری به specification ساخت‌یافته Markdown تبدیل کنید</td>
  </tr>
  <tr>
    <td><strong><a href="docs/companion.md">Companion</a></strong></td>
    <td dir="rtl" align="right">همراه شناور Companion برای parsing، help و typeها</td>
  </tr>
</table>

<h3 dir="rtl" align="right">⚙️ تنظیمات و ارجاعات</h3>

<table>
  <tr>
    <th>سند</th>
    <th dir="rtl" align="right">چه چیزی را پوشش می‌دهد</th>
  </tr>
  <tr>
    <td><strong><a href="docs/installation.md">راهنمای نصب</a></strong></td>
    <td dir="rtl" align="right">نصب Plugin، استفاده از flagهای CLI، reset کردن config و عیب‌یابی setup</td>
  </tr>
  <tr>
    <td dir="rtl" align="right"><strong><a href="docs/opencode-v2-compatibility.md">سازگاری با OpenCode v2</a></strong></td>
    <td dir="rtl" align="right">اجرای همان Plugin روی <code>opencode2</code>: ماتریس featureها، baseline سازگاری با v2.0.x و pin کردن version</td>
  </tr>
  <tr>
    <td><strong><a href="docs/configuration.md">Configuration</a></strong></td>
    <td dir="rtl" align="right">محل فایل‌های config، پشتیبانی JSONC، Prompt override و مرجع کامل optionها</td>
  </tr>
  <tr>
    <td><strong><a href="docs/project-local-customization.md">سفارشی‌سازی پروژه</a></strong></td>
    <td dir="rtl" align="right">Agentهای سفارشی مخصوص repository، Prompt override، Skillهای هر Agent و precedence</td>
  </tr>
  <tr>
    <td><strong><a href="docs/background-orchestration.md">Background Orchestration</a></strong></td>
    <td dir="rtl" align="right">مدل Orchestrator مبتنی بر scheduler که حول subagentهای native پس‌زمینه ساخته شده است</td>
  </tr>
  <tr>
    <td dir="rtl" align="right"><strong><a href="docs/maintainers.md">راهنمای Maintainer</a></strong></td>
    <td dir="rtl" align="right">قوانین triage کردن issueها، معنی labelها، routing پشتیبانی و workflow نگهداری repository</td>
  </tr>
  <tr>
    <td><strong><a href="docs/skills.md">Skills</a></strong></td>
    <td dir="rtl" align="right">Skillهای همراه مانند <code>simplify</code>، <code>codemap</code>، <code>clonedeps</code>، <code>deepwork</code>، <code>verification-planning</code>، <code>reflect</code>، <code>worktrees</code> و <code>oh-my-opencode-slim</code></td>
  </tr>
  <tr>
    <td><strong><a href="docs/mcps.md">MCPها</a></strong></td>
    <td dir="rtl" align="right"><code>context7</code>، <code>gh_grep</code> و نحوه کار permissionهای MCP برای هر Agent</td>
  </tr>
  <tr>
    <td><strong><a href="docs/tools.md">Tools</a></strong></td>
    <td dir="rtl" align="right">قابلیت‌های داخلی ابزارها مانند <code>webfetch</code>، ابزارهای LSP، جست‌وجوی کد و formatterها</td>
  </tr>
</table>

---

<a id="contributors-"></a>

## 🏛️ مشارکت‌کنندگان

<div align="center">
  <p dir="rtl" align="right"><i>سازندگان، debuggerها، نویسندگان و جست‌وجوگرانی که جایگاه خود را در Pantheon به دست آورده‌اند.</i></p>
  <p dir="rtl" align="right"><sub>هر contribution که merge شود، اثری در این قلمرو بر جا می‌گذارد.</sub></p>

  <!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
[![همه مشارکت‌کنندگان](https://img.shields.io/badge/all_contributors-115-orange.svg?style=flat-square)](#contributors-)
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
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/DanMaly"><img src="https://avatars.githubusercontent.com/u/69809112?v=4?s=100" width="100px;" alt="Daniel Maly"/><br /><sub><b>Daniel Maly</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=DanMaly" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/Chewji9875"><img src="https://avatars.githubusercontent.com/u/126886556?v=4?s=100" width="100px;" alt="Chewji"/><br /><sub><b>Chewji</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Chewji9875" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/DanielMaly"><img src="https://avatars.githubusercontent.com/u/1443921?v=4?s=100" width="100px;" alt="Daniel Maly"/><br /><sub><b>Daniel Maly</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=DanielMaly" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://giuseppebellamacina.com/"><img src="https://avatars.githubusercontent.com/u/102151655?v=4?s=100" width="100px;" alt="Giuseppe Bellamacina"/><br /><sub><b>Giuseppe Bellamacina</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=GiuseppeBellamacina" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/Zhanyuanium"><img src="https://avatars.githubusercontent.com/u/92024923?v=4?s=100" width="100px;" alt="Zhanyuanium"/><br /><sub><b>Zhanyuanium</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Zhanyuanium" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/kaze-gif"><img src="https://avatars.githubusercontent.com/u/114116466?v=4?s=100" width="100px;" alt="かぜ"/><br /><sub><b>かぜ</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=kaze-gif" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/tsankotsanev"><img src="https://avatars.githubusercontent.com/u/76694544?v=4?s=100" width="100px;" alt="Tsanko Tsanev"/><br /><sub><b>Tsanko Tsanev</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=tsankotsanev" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/shixi-li"><img src="https://avatars.githubusercontent.com/u/40780706?v=4?s=100" width="100px;" alt="cyril"/><br /><sub><b>cyril</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=shixi-li" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/pmolinal"><img src="https://avatars.githubusercontent.com/u/1817596?v=4?s=100" width="100px;" alt="Patricio Molina"/><br /><sub><b>Patricio Molina</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=pmolinal" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/vinilouz"><img src="https://avatars.githubusercontent.com/u/20116132?v=4?s=100" width="100px;" alt="vinilouz"/><br /><sub><b>vinilouz</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=vinilouz" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/MyGO-Mujica"><img src="https://avatars.githubusercontent.com/u/190353468?v=4?s=100" width="100px;" alt="Homura"/><br /><sub><b>Homura</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=MyGO-Mujica" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://major.io/"><img src="https://avatars.githubusercontent.com/u/89910?v=4?s=100" width="100px;" alt="Major Hayden"/><br /><sub><b>Major Hayden</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=major" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/FrancoStino"><img src="https://avatars.githubusercontent.com/u/32127923?v=4?s=100" width="100px;" alt="Davide Ladisa"/><br /><sub><b>Davide Ladisa</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=FrancoStino" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/Max-Null"><img src="https://avatars.githubusercontent.com/u/24647158?v=4?s=100" width="100px;" alt="Max-Null"/><br /><sub><b>Max-Null</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Max-Null" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/brucemead"><img src="https://avatars.githubusercontent.com/u/5895525?v=4?s=100" width="100px;" alt="Bruce"/><br /><sub><b>Bruce</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=brucemead" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/lih54767-coder"><img src="https://avatars.githubusercontent.com/u/271720354?v=4?s=100" width="100px;" alt="zhaohaofan"/><br /><sub><b>zhaohaofan</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=lih54767-coder" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/adevwithpurpose"><img src="https://avatars.githubusercontent.com/u/197252873?v=4?s=100" width="100px;" alt="adevwithpurpose"/><br /><sub><b>adevwithpurpose</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=adevwithpurpose" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://space.bilibili.com/67279156"><img src="https://avatars.githubusercontent.com/u/26923626?v=4?s=100" width="100px;" alt="Gold John King"/><br /><sub><b>Gold John King</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=GoldJohnKing" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/pxmpsdev"><img src="https://avatars.githubusercontent.com/u/180872771?v=4?s=100" width="100px;" alt="pxmps"/><br /><sub><b>pxmps</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=pxmpsdev" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/raphaelwdrf"><img src="https://avatars.githubusercontent.com/u/61286068?v=4?s=100" width="100px;" alt="raphaelwdrf"/><br /><sub><b>raphaelwdrf</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=raphaelwdrf" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/KomeijiReimu"><img src="https://avatars.githubusercontent.com/u/118449321?v=4?s=100" width="100px;" alt="Brant"/><br /><sub><b>Brant</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=KomeijiReimu" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/ermanhavuc"><img src="https://avatars.githubusercontent.com/u/29822518?v=4?s=100" width="100px;" alt="Erman HAVUÇ"/><br /><sub><b>Erman HAVUÇ</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=ermanhavuc" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/HeZ2z"><img src="https://avatars.githubusercontent.com/u/142383180?v=4?s=100" width="100px;" alt="HeZzz"/><br /><sub><b>HeZzz</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=HeZ2z" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/Qiaoyi-Li"><img src="https://avatars.githubusercontent.com/u/76148131?v=4?s=100" width="100px;" alt="Qiaoyi Li"/><br /><sub><b>Qiaoyi Li</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Qiaoyi-Li" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://arpankanwer.ai.studio/"><img src="https://avatars.githubusercontent.com/u/35032317?v=4?s=100" width="100px;" alt="Birarpanjot Singh Kanwer"/><br /><sub><b>Birarpanjot Singh Kanwer</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=arpankanwer" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/Iams4kura"><img src="https://avatars.githubusercontent.com/u/126048986?v=4?s=100" width="100px;" alt="s4kura"/><br /><sub><b>s4kura</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Iams4kura" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/zjm54321"><img src="https://avatars.githubusercontent.com/u/20168947?v=4?s=100" width="100px;" alt="落花有意"/><br /><sub><b>落花有意</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=zjm54321" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/JoJohanse"><img src="https://avatars.githubusercontent.com/u/97782983?v=4?s=100" width="100px;" alt="JoJohanse"/><br /><sub><b>JoJohanse</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=JoJohanse" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/Alfiegerner"><img src="https://avatars.githubusercontent.com/u/596188?v=4?s=100" width="100px;" alt="Alfiegerner"/><br /><sub><b>Alfiegerner</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Alfiegerner" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/leducmaxime"><img src="https://avatars.githubusercontent.com/u/37900355?v=4?s=100" width="100px;" alt="Maxime Leduc"/><br /><sub><b>Maxime Leduc</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=leducmaxime" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/vmvarela"><img src="https://avatars.githubusercontent.com/u/11040851?v=4?s=100" width="100px;" alt="Victor M. Varela"/><br /><sub><b>Victor M. Varela</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=vmvarela" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/gitslim"><img src="https://avatars.githubusercontent.com/u/24612825?v=4?s=100" width="100px;" alt="gitslim"/><br /><sub><b>gitslim</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=gitslim" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/xiaolf0813"><img src="https://avatars.githubusercontent.com/u/314566924?v=4?s=100" width="100px;" alt="xiaolf0813"/><br /><sub><b>xiaolf0813</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=xiaolf0813" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/BaconDroid"><img src="https://avatars.githubusercontent.com/u/11067111?v=4?s=100" width="100px;" alt="BaconDroid"/><br /><sub><b>BaconDroid</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=BaconDroid" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://sprightly-strudel-e1f939.netlify.app/"><img src="https://avatars.githubusercontent.com/u/277080233?v=4?s=100" width="100px;" alt="Enoch"/><br /><sub><b>Enoch</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=bferanmi806-sketch" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/mxalbert1996"><img src="https://avatars.githubusercontent.com/u/9391933?v=4?s=100" width="100px;" alt="Albert Chang"/><br /><sub><b>Albert Chang</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=mxalbert1996" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/Aveer"><img src="https://avatars.githubusercontent.com/u/84144527?v=4?s=100" width="100px;" alt="Aveer"/><br /><sub><b>Aveer</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Aveer" title="Code">💻</a></td>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/Amm1rr"><img src="https://avatars.githubusercontent.com/u/480468?v=4?s=100" width="100px;" alt="Mohammad"/><br /><sub><b>Mohammad</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=Amm1rr" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/kumar-shivang"><img src="https://avatars.githubusercontent.com/u/89011717?v=4?s=100" width="100px;" alt="Shivang Kumar"/><br /><sub><b>Shivang Kumar</b></sub></a><br /><a href="https://github.com/alvinunreal/oh-my-opencode-slim/commits?author=kumar-shivang" title="Code">💻</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

---

## 📄 مجوز

MIT

---
