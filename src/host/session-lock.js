// @ts-check
/**
 * 轻量异步互斥锁：按 sessionId 串行化同一会话的写操作，避免同步/自动补齐/清空/重切并发撞车。
 */

export function createSessionLock() {
  /** @type {Map<string, Promise<void>>} */
  const tails = new Map();

  /**
   * 在指定 key（通常为 sessionId 或 '__global__'）的串行队列中执行 fn。
   * @template T
   * @param {string} key
   * @param {() => Promise<T> | T} fn
   * @returns {Promise<T>}
   */
  async function withLock(key, fn) {
    const k = String(key || '__global__');
    const prev = tails.get(k) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const next = prev.then(() => gate, () => gate);
    tails.set(k, next);

    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (tails.get(k) === next) {
        tails.delete(k);
      }
    }
  }

  return { withLock };
}
