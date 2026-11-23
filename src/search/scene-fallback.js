/**
 * `vec_scene`（整场 gist 向量）是否参与主检索。
 *
 * **默认关闭。** 用 30~60 字概括整场 40+ 轮对话容易偏向场景开头、丢失深处细节；
 * 整场语义召回由 `vec_window`（场景内滑动对话窗）承担，
 * `gist` 专注于时间轴目录标题（`gistHeadline`）。
 *
 * 保留这个开关以便在需要时对照或启用旧路径。
 */
export const SCENE_FALLBACK_ENABLED = false;

export default SCENE_FALLBACK_ENABLED;
