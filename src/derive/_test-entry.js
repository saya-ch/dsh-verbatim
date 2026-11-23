/**
 * 测试入口聚合器 —— 仅为兼容 Node v24 的 `node --test <目录>` 行为。
 *
 * 原因（实测，Node v24.13.1 / win32）：
 * `node --test src/derive/` 不会展开目录里的 *.test.js，
 * 而是把目录按包解析规则当成「入口模块」去加载 —— 没有 main 就报
 * `Cannot find module .../src/derive`。
 *
 * 所以 package.json 的 main 指向本文件；本文件 import 三个测试文件，
 * 它们的用例在加载时就注册到 node:test，于是 `node --test src/derive/` 能全跑。
 *
 * 这不是测试逻辑，只是入口。真正的用例在 fact.test.js / gist.test.js / beat.test.js。
 * 想按文件挑选运行，直接用：`node --test src/derive/fact.test.js`。
 */

import './fact.test.js';
import './gist.test.js';
import './beat.test.js';
