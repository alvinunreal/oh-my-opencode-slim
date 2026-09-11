import { describe, expect, test } from 'bun:test';
import { createJSDOMLoader, loadJSDOM, probeJSDOM } from './jsdom';

describe('jsdom loader', () => {
  test('loads jsdom and constructs a basic document', async () => {
    const { JSDOM } = await loadJSDOM();
    const dom = new JSDOM('<p id="message">hello</p>');

    expect(dom.window.document.querySelector('#message')?.textContent).toBe(
      'hello',
    );
    dom.window.close();
  }, 15_000);

  test('shares the in-flight module load', async () => {
    const jsdom = await loadJSDOM();
    let loadCount = 0;
    const load = createJSDOMLoader(async () => {
      loadCount += 1;
      await Promise.resolve();
      return jsdom;
    });

    const firstPromise = load();
    const secondPromise = load();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(loadCount).toBe(1);
    expect(firstPromise).toBe(secondPromise);
    expect(first.JSDOM).toBe(second.JSDOM);
    expect(first.VirtualConsole).toBe(second.VirtualConsole);
  });

  test('does not cache a failed load', async () => {
    const jsdom = await loadJSDOM();
    let loadCount = 0;
    const load = createJSDOMLoader(async () => {
      loadCount += 1;
      if (loadCount === 1) throw new Error('transient jsdom failure');
      return jsdom;
    });

    await expect(load()).rejects.toThrow('transient jsdom failure');
    await expect(load()).resolves.toBe(jsdom);
    expect(loadCount).toBe(2);
  });

  test('reports loader failures without throwing from the probe', async () => {
    const result = await probeJSDOM(async () => {
      throw new Error('jsdom unavailable');
    });

    expect(result).toBe('Error: jsdom unavailable');
  });
});
