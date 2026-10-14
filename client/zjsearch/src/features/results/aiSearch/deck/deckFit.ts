// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

// 幻灯片溢出自动适配（DESIGN.md §5.2 家族契约，ZJBlog
// src/features/deck/deckFit.ts 孪生）：固定 1280×720 画布上超高的正文原本
// 被 overflow 裁掉——这里检测溢出并对 compile 期包好的 .deck-body 施加等比
// 缩放 + 宽度补偿，整页内容按原版面完整缩小落进画布。
//
// 原理：section 的布局宽恒为 1280px CSS px（视口缩放在画布层 transform），
// 因此测量一次即稳定、不随窗口改变；scale 不参与布局，scrollHeight 始终
// 反映原始内容高度，撤销重测幂等。缩放下限之下宁可保留裁切——无限缩小
// 等于不可读。display:none 的页量不出尺寸：逐页模式只量可见页，翻到时
// 再量；迟到内容（mermaid svg、图片）由查看器挂的 MutationObserver 触发
// 重测（fit 只改 style/attribute，不在 childList 观察范围，无回环）。

const MIN_SCALE = 0.5;
/** 缩放下限：再往下文字已不可读。 */

/** 适配单页：溢出时对 .deck-body 施加 scale + 宽度补偿，返回是否适配了。 */
export function fitSlide(section: HTMLElement): boolean {
  const body = section.querySelector<HTMLElement>(":scope > .deck-body");
  if (!body) {
    return false;
  }
  body.style.transform = "";
  body.style.width = "";
  delete section.dataset.deckFit;
  const cs = getComputedStyle(section);
  const padTop = Number.parseFloat(cs.paddingTop) || 0;
  const padBottom = Number.parseFloat(cs.paddingBottom) || 0;
  const contentBox = section.clientHeight - padTop - padBottom;
  // 内容实际高度 = wrapper 自己的 scrollHeight（不受 transform 影响）。
  // 不能用 section.scrollHeight：它被钳到 clientHeight、且把 padding-bottom
  // 算进去——没溢出的页会误报成恰好超出一个 padding 的量。
  const bodyExtent = body.scrollHeight;
  if (contentBox <= 0 || bodyExtent <= contentBox + 1) {
    return false;
  }
  const scale = Math.max(MIN_SCALE, contentBox / bodyExtent);
  body.style.transformOrigin = "top left";
  body.style.transform = `scale(${scale})`;
  // 宽度补偿：先按 1/s 放宽排版再缩回，正文有效行宽不变、整页等比缩小
  body.style.width = `${100 / scale}%`;
  section.dataset.deckFit = scale.toFixed(2);
  return true;
}

/** 量所有当前可见的页：逐页模式只有当前页可见（display:none 量不出尺寸，
 *  翻到时由换页 effect 再量），连续/打印揭示后自然全覆盖。 */
export function fitVisibleSlides(root: HTMLElement): void {
  for (const section of root.querySelectorAll<HTMLElement>("section[data-slide]")) {
    if (section.offsetParent !== null) {
      fitSlide(section);
    }
  }
}

/** 迟到内容的重测观察：mermaid 占位符被渲染器替换成 svg、图片加载完成等
 *  DOM 变化后，防抖重量可见页。查看器在画布挂载时接一次，卸载时清理。 */
export function observeLateContent(root: HTMLElement): () => void {
  let timer = 0;
  const observer = new MutationObserver(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      fitVisibleSlides(root);
    }, 180);
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => {
    window.clearTimeout(timer);
    observer.disconnect();
  };
}
