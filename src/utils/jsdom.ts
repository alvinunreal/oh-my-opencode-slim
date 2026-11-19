import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export type JsdomModule = typeof import('jsdom');
type JsdomLoader = () => Promise<JsdomModule>;

async function importJSDOM(): Promise<JsdomModule> {
  const require = createRequire(import.meta.url);
  const entrypoint = require.resolve('jsdom');
  return (await import(pathToFileURL(entrypoint).href)) as JsdomModule;
}

export function createJSDOMLoader(loader: JsdomLoader): JsdomLoader {
  let promise: Promise<JsdomModule> | undefined;

  return () => {
    if (promise) return promise;

    const pending = loader().catch((error) => {
      if (promise === pending) promise = undefined;
      throw error;
    });
    promise = pending;
    return pending;
  };
}

const loadJSDOMFromFile = createJSDOMLoader(importJSDOM);

/**
 * Resolve jsdom to its installed file before importing it. This keeps
 * transitive relative asset loads anchored to a real filesystem URL instead
 * of the host's bundled module URL.
 */
export function loadJSDOM(): Promise<JsdomModule> {
  return loadJSDOMFromFile();
}
