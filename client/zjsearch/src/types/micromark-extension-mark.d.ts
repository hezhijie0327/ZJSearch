// micromark-extension-mark@1.0.2 ships no type declarations (pure js);
// tsconfig paths redirects to this shim.  pandocMark is a factory function
// returning a micromark Extension (consumed as unknown here: injected into
// data.micromarkExtensions, micromark composes them itself).
declare function pandocMark(options?: unknown): unknown;

export { pandocMark };
