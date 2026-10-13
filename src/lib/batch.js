/**
 * テキストを件数・文字数の上限でバッチに分ける。
 * @returns {number[][]} 各バッチに含まれる texts のインデックス
 */
export function makeBatches(texts, { maxUnits, maxChars }) {
  const batches = [];
  let current = [];
  let chars = 0;
  texts.forEach((text, i) => {
    if (current.length && (current.length >= maxUnits || chars + text.length > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(i);
    chars += text.length;
  });
  if (current.length) batches.push(current);
  return batches;
}
