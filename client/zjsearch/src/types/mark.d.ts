// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// micromark-extension-mark ships without types (mdast-util-mark, its typed
// sibling, is imported directly for the from-markdown half)
declare module "micromark-extension-mark" {
  export function pandocMark(): unknown;
}
