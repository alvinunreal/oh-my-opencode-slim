export function renderInterviewPage(interviewId: string): string {
  const safeTitle = interviewId
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Interview ${safeTitle}</title>
    <style>
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
        width: 144px;
        height: 144px;
        object-fit: contain;
        filter: drop-shadow(0 10px 30px rgba(255,255,255,0.1));
      }
      h1 { font-size: 32px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 12px; line-height: 1.2; }
      h2 { font-size: 18px; font-weight: 500; letter-spacing: 0.05em; text-transform: uppercase; color: rgba(255,255,255,0.4); margin-bottom: 24px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 12px; }
      h3 { font-size: 18px; font-weight: 500; margin-bottom: 16px; line-height: 1.4; }
      p { margin-top: 0; }
      .muted { color: rgba(255,255,255,0.5); font-size: 16px; }
      .meta { display: flex; align-items: center; justify-content: space-between; font-size: 13px; color: rgba(255,255,255,0.4); margin-bottom: 16px; letter-spacing: 0.05em; text-transform: uppercase; }
      
      .file-path-container {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13px;
        color: rgba(255,255,255,0.6);
        background: rgba(255,255,255,0.05);
        padding: 8px 12px;
        border-radius: 6px;
        margin-bottom: 36px;
        display: flex;
        align-items: center;
        gap: 8px;
        border: 1px solid rgba(255,255,255,0.08);
      }
      .file-path-icon {
        opacity: 0.5;
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
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="brand-header">
        <svg
          class="brand-mark"
          viewBox="0 0 144 144"
          role="img"
          aria-label="Oh My Opencode Slim"
        >
          <rect
            x="12"
            y="12"
            width="120"
            height="120"
            rx="32"
            fill="rgba(255,255,255,0.08)"
            stroke="rgba(255,255,255,0.18)"
            stroke-width="2"
          />
          <path
            d="M50 48h18c16 0 26 10 26 24s-10 24-26 24H50z"
            fill="none"
            stroke="white"
            stroke-width="8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M74 48h20c10 0 18 8 18 18v12c0 10-8 18-18 18H74"
            fill="none"
            stroke="white"
            stroke-width="8"
            stroke-linecap="round"
            stroke-linejoin="round"
            opacity="0.65"
          />
        </svg>
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
      </div>

      <div id="questions"></div>
      
       <button class="primary" id="submitButton" disabled>Submit Answers <span class="submit-shortcut">⌘↵</span></button>
      
      <div class="footer" id="submitStatus"></div>
    </div>
    
    <div class="loading-overlay" id="loadingOverlay">
      <div class="status-text" id="loadingText">Processing...</div>
    </div>

    <script>
      const interviewId = ${JSON.stringify(interviewId)};
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

      function renderQuestions(questions) {
        const sig = JSON.stringify(questions);
        const container = document.getElementById('questions');

        if (state.lastSig === sig) {
          questions.forEach((q) => updateOptionsDOM(q.id));
          updateActiveQuestionFocus();
          return;
        }
        
        state.lastSig = sig;
        container.replaceChildren();

        if (!questions.length && !state.data?.isBusy) {
          const empty = document.createElement('p');
          empty.className = 'muted';
          empty.style.textAlign = 'center';
          empty.style.padding = '48px 0';
          empty.textContent = 'No active questions right now.';
          container.appendChild(empty);
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
        document.getElementById('summary').textContent = data.summary || 'Session in progress.';
        document.getElementById('status').textContent = data.mode.toUpperCase();
        
        // Render Markdown Path
        const pathContainer = document.getElementById('filePathContainer');
        const pathElement = document.getElementById('markdownPath');
        const mdPath = data.markdownPath || (data.interview && data.interview.markdownPath);
        if (mdPath) {
          pathElement.textContent = mdPath;
          pathContainer.style.display = 'flex';
        } else {
          pathContainer.style.display = 'none';
        }
        
        renderQuestions(data.questions || []);
        updateSubmitButton();
      }

      async function refresh() {
        const response = await fetch('/api/interviews/' + encodeURIComponent(interviewId) + '/state');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to load state');
        render(data);
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

      refresh().catch((error) => {
        document.getElementById('submitStatus').textContent = error.message || 'Failed to load interview.';
      });
      setInterval(() => {
        refresh().catch(() => {});
      }, 2500);
    </script>
  </body>
</html>`;
}
