// micromark-extension-mark@1.0.2 无类型声明（纯 js），经 tsconfig paths
// 重定向到本 shim。pandocMark 是工厂函数，返回 micromark Extension（此处按
// unknown 消费：注入 data.micromarkExtensions 后由 micromark 自行组合）。
declare function pandocMark(options?: unknown): unknown;

export { pandocMark };
