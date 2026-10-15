/** 「クリックした先のページも自動で翻訳する」ときに、翻訳を続けるタブを覚えておく */
export const FOLLOW_KEY = 'followTabs';

const TRANSLATABLE = /^https?:/;

/**
 * @param {object} deps
 * @param {{ get(key: string): Promise<object>, set(items: object): Promise<void> }} deps.storage
 *   service worker が止まっても覚えておけるよう chrome.storage.session を渡す
 * @param {(tabId: number) => Promise<void>} deps.inject タブに content script を入れて翻訳を始める
 * @param {() => Promise<boolean>} deps.isEnabled 設定がオンで、全サイトへのアクセスが許可されているか
 */
export function createFollower({ storage, inject, isEnabled }) {
  const load = async () => new Set((await storage.get(FOLLOW_KEY))[FOLLOW_KEY] ?? []);
  const save = (tabs) => storage.set({ [FOLLOW_KEY]: [...tabs] });

  async function start(tabId) {
    if (!(await isEnabled())) return;
    const tabs = await load();
    tabs.add(tabId);
    await save(tabs);
  }

  async function stop(tabId) {
    const tabs = await load();
    if (tabs.delete(tabId)) await save(tabs);
  }

  async function onUpdated(tabId, changeInfo, tab) {
    if (changeInfo.status !== 'complete' || !TRANSLATABLE.test(tab?.url ?? '')) return;
    if (!(await load()).has(tabId) || !(await isEnabled())) return;
    try {
      await inject(tabId);
    } catch {
      // ページが閉じられた・アクセスできないページなど。次のページ移動でまた試す
    }
  }

  /** 翻訳中のタブのリンクから開かれた新しいタブ（target="_blank" など）も翻訳を続ける */
  async function onCreated(tab) {
    if (tab?.openerTabId == null || !(await load()).has(tab.openerTabId)) return;
    await start(tab.id);
  }

  return { start, stop, onUpdated, onCreated, onRemoved: stop };
}
