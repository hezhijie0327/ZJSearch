// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// marp-core 的两个重依赖替身（DESIGN.md §5.2 deck 家族契约）：内核把
// mathjax-full（兆级）和 highlight.js 全语言注册表静态 require 进模块顶层，
// 而 deck 编译把配置钉死在 math: "katex" + highlight: () => ""——两条代码
// 路径永不执行。bundler alias 把这两组 require 指到本文件：一个什么都
// 「是」的 Proxy（任意属性访问/调用/构造都返回自身），内核顶层对它们的
// 解构安全通过，懒加载 chunk 只背 marpit + markdown-it + katex。
// 升级 marp-core 时这里要跟着对一遍（新顶层 require 需要新的 alias 条目）。
const stub = new Proxy(() => {}, {
  get: (_target, prop) => (prop === "__esModule" ? false : stub),
  apply: () => stub,
  construct: () => stub,
});

module.exports = stub;
