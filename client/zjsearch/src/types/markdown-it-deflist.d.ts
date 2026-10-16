// markdown-it-deflist has no official types: a minimal declaration
// (plugin function, attached directly via md.use)
// (twin of ZJBlog's tools/markdown-it-deflist.d.ts)
declare module "markdown-it-deflist" {
  const deflist: (md: unknown) => void;
  export default deflist;
}
