// mdast-util-mark@1.0.0 publishes uncompiled .ts as its entry point -- tsc
// following the import would typecheck the third-party source and error
// under verbatimModuleSyntax.  tsconfig paths redirects to this shim
// (type level only; at runtime vite still resolves the real package).
// Same pattern as ZJBlog's tools/types.
declare module "mdast-util-mark" {
  type Extension = {
    canContainEols?: string[];
    enter: Record<string, (this: unknown, token: unknown) => unknown>;
    exit: Record<string, (this: unknown, token: unknown) => unknown>;
  };
  export const pandocMarkFromMarkdown: Extension;
}
