// @ts-check
/**
 * 向量基础运算、维度校验与 BLOB 序列化。
 *
 * 约定：
 * - 所有入库与查询向量必须先做 L2 归一化，使 vec0 的 L2 距离与暴力余弦分数完全等价。
 * - `toBlob` 必须返回字节副本（Uint8Array.from），防止 `node:sqlite` 绑定参数时
 *   复用缓冲原地篡改调用方持有的 Float32Array。
 */

/** 默认向量维度（可通过建库参数或 recreateVecTables 覆盖） */
export const DEFAULT_DIM = 1024;

/** KNN 候选放大倍数：先多取，再在外层按会话与时间窗口过滤 */
export const DEFAULT_OVER_FETCH = 8;

/** 降级模式的落盘表名（只在不加载 sqlite-vec 时创建） */
export const FALLBACK_TABLES = {
  msg: 'vec_fallback_msg',
  scene: 'vec_fallback_scene',
  chunk: 'vec_fallback_chunk',
  note: 'vec_fallback_note',
  window: 'vec_fallback_window',
};

/**
 * 把各种入参统一成 Float32Array。
 * @param {Float32Array|number[]|Uint8Array|ArrayBuffer} input
 * @param {number} dim
 * @param {string} [what]
 * @returns {Float32Array}
 */
export function toFloat32(input, dim, what = '向量') {
  if (input instanceof Float32Array) {
    if (input.length !== dim) {
      throw new TypeError(`${what}维度不对：要 ${dim} 维，收到 ${input.length} 维`);
    }
    return input;
  }
  if (input instanceof Uint8Array) {
    if (input.byteLength !== dim * 4) {
      throw new TypeError(`${what}的字节数不对：要 ${dim * 4} 字节（${dim} 维 float32），收到 ${input.byteLength}`);
    }
    const copy = new Uint8Array(input);
    return new Float32Array(copy.buffer, copy.byteOffset, dim);
  }
  if (input instanceof ArrayBuffer) {
    return toFloat32(new Uint8Array(input), dim, what);
  }
  if (Array.isArray(input)) {
    if (input.length !== dim) {
      throw new TypeError(`${what}维度不对：要 ${dim} 维，收到 ${input.length} 维`);
    }
    return Float32Array.from(input);
  }
  throw new TypeError(`${what}必须是 Float32Array / number[] / BLOB，收到 ${typeof input}`);
}

/**
 * L2 归一化。返回新的 Float32Array，绝不修改调用方数组。
 * @param {Float32Array|number[]|Uint8Array|ArrayBuffer} input
 * @param {number} dim
 * @param {string} [what]
 * @returns {Float32Array}
 */
export function normalizeVector(input, dim, what = '向量') {
  const src = toFloat32(input, dim, what);
  const out = new Float32Array(dim);
  let sumSq = 0;
  for (let i = 0; i < dim; i++) {
    const v = src[i];
    if (!Number.isFinite(v)) {
      throw new TypeError(`${what}: 第 ${i} 维不是有限数值（${v}）`);
    }
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) out[i] = src[i] / norm;
  } else {
    out[0] = 1;
  }
  return out;
}

/**
 * Float32Array → BLOB（供 node:sqlite 绑定；返回副本以切断共享内存）。
 * @param {Float32Array} vector
 * @returns {Uint8Array}
 */
export function toBlob(vector) {
  return Uint8Array.from(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
}

/**
 * 点积（单位向量下等价于余弦相似度）。
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}
 */
export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * L2 距离 → 余弦。
 * @param {number} distance
 * @returns {number}
 */
export function distanceToScore(distance) {
  const d2 = Math.min(4, Math.max(0, distance * distance));
  return 1 - d2 / 2;
}

/**
 * 余弦 → L2 距离。
 * @param {number} score
 * @returns {number}
 */
export function scoreToDistance(score) {
  const cos = Math.min(1, Math.max(-1, score));
  return Math.sqrt(Math.max(0, 2 - 2 * cos));
}
