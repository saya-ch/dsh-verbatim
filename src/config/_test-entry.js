// _test-entry.js —— 让 `node --test src/config/` 也能跑全部用例
//
// 原因（与 src/store、src/derive 的 package.json 说明同一件事）：
// Node v24 的 `node --test <目录>` 不展开目录找 *.test.js，而是按包解析规则
// 把目录当入口模块。把 package.json 的 main 指向本文件、本文件把两个测试文件
// import 进来，目录形式就能跑全。
//
// 跨目录 import 请写显式相对路径（'./exclude-range.js'），勿依赖目录解析。

import './exclude-range.test.js';
import './session-config.test.js';
