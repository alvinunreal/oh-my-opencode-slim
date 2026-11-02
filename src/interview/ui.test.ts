import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { renderInterviewPage } from './ui';

function createInterviewDom() {
  const dom = new JSDOM(renderInterviewPage('interview-id', 'interview'), {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1/',
  });
  const { window } = dom;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const script = window.document.querySelector('script')?.textContent ?? '';
  const initialization = script.lastIndexOf('      refresh().catch(');
  expect(initialization).toBeGreaterThan(0);
  // Return render from a closure: Bun 1.3's node:vm drops top-level
  // declarations from window.eval, so they can't be read in a later call.
  const render = window.eval(
    `(() => {${script.slice(0, initialization)}\nsseConnected = true;\nreturn render;})()`,
  ) as (state: unknown) => void;
  return { dom, render };
}

test('allows answering a question without options', () => {
  const { dom, render } = createInterviewDom();
  try {
    const { window } = dom;
    render({
      interview: { id: 'interview-id', idea: 'Idea' },
      mode: 'awaiting-user',
      isBusy: false,
      summary: 'Draft',
      questions: [{ id: 'q-free', question: 'What?', options: [] }],
    });
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

test('refreshes a completed view when its specification changes', () => {
  const { dom, render } = createInterviewDom();
  try {
    const { window } = dom;
    const state = (content: string) => ({
      interview: { id: 'interview-id', idea: 'Idea' },
      mode: 'completed',
      isBusy: false,
      summary: 'Done',
      questions: [],
      document: `# Idea\n\n## Current spec\n${content}\n\n## Q&A history\n`,
      blocks: [{ title: 'Requirements', content }],
    });
    render(state('OLD_REQUIREMENT'));
    render(state('NEW_REQUIREMENT'));
    const rendered = window.document.getElementById('questions')?.textContent;
    expect(rendered).toContain('NEW_REQUIREMENT');
    expect(rendered).not.toContain('OLD_REQUIREMENT');
  } finally {
    dom.window.close();
  }
});
