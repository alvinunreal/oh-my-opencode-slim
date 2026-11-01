import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderInterviewPage } from './ui';

test('allows answering a question without options', () => {
  const dom = new JSDOM(renderInterviewPage('interview-id', 'interview'), {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1/',
  });
  try {
    const { window } = dom;
    window.HTMLElement.prototype.scrollIntoView = () => {};
    const script = window.document.querySelector('script')?.textContent ?? '';
    const initialization = script.lastIndexOf('      refresh().catch(');
    expect(initialization).toBeGreaterThan(0);
    window.eval(`${script.slice(0, initialization)}
      sseConnected = true;
      render(${JSON.stringify({
        interview: { id: 'interview-id', idea: 'Idea' },
        mode: 'awaiting-user',
        isBusy: false,
        summary: 'Draft',
        questions: [{ id: 'q-free', question: 'What?', options: [] }],
      })});`);
    const textarea = window.document.getElementById(
      'answer-q-free',
    ) as HTMLTextAreaElement;
    expect(window.getComputedStyle(textarea).display).not.toBe('none');
    textarea.value = 'An answer';
    textarea.dispatchEvent(new window.Event('input'));
    expect(
      (window.document.getElementById('submitButton') as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  } finally {
    dom.window.close();
  }
});
