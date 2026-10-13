import { JSDOM } from 'jsdom';

export function makeDocument(bodyHtml, { title = '' } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>${title}</title></head><body>${bodyHtml}</body></html>`,
  );
  return { window: dom.window, document: dom.window.document };
}
