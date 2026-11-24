// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import type { AiOverviewDebugScenario } from "@/features/results/aiSearch/debug/types.ts";

const META =
  '<<<zjs-meta:{"finish":"stop","model":"demo-model","usage":{"input":4210,"output":386,"thoughts":180,"cached":1024,"cache_write":0}}>>>';

const SOURCES = [
  { favicon: "", domain: "example.com", t: "三种经典折法的步骤图解", u: "https://example.com/folds" },
  {
    favicon: "",
    domain: "paper.example.org",
    t: "纸张克重对飞行距离的影响(社团实测)",
    u: "https://paper.example.org/weight-test",
  },
];

/** The AI Overview card's stream, split by its raw markers: the `<think>`
    block, the answer with its [n] citations, the tail meta sentinel. */
export const OVERVIEW_STREAMED: AiOverviewDebugScenario = {
  id: "ov-streamed",
  label: "full stream (think · citations · tail meta)",
  q: "纸飞机怎么折飞得远?",
  chunks: [
    "<think>用户问怎么折飞得远。材料集中在折法和纸张两条线:",
    "滑翔形距离与滞空都最好,80g 纸更挺括。按「折法 → 纸张」组织,数字带引用。</think>",
    "想飞得远,折法和纸张各占一半:\n\n",
    "- **折法**:选滑翔形,翼面宽、滞空久,平均能飞 **15.8 米**[1];\n",
    "- **纸张**:用 80g 的 A4 纸,比 70g 平均多飞 1.8 米[2]。\n\n",
    "折的时候两翼要完全对称,滑翔形的翼尾向上折 1 厘米,否则容易俯冲。",
    META,
  ],
  sources: SOURCES,
  phase: "done",
};

/** A fence-dense answer: the stream splitter must not read the `<think>`
    and [n] tokens INSIDE a code fence as markers. */
export const OVERVIEW_FENCES: AiOverviewDebugScenario = {
  id: "ov-fences",
  label: "fence-dense (splitter)",
  q: "给一个折法对比表和 mermaid 图",
  chunks: [
    "<think>带表格与 mermaid 的回答:splitAnswerStream 不能把 fence 里的内容当 think。</think>",
    '三种折法的对比:\n\n| | 镖形 | 滑翔形 | 特技形 |\n|---|---|---|---|\n| 平均距离 | 12.4 米[1] | 15.8 米[1] | 8.2 米[1] |\n| 上手难度 | 容易 | 中等 | 较难 |\n\n```mermaid\nxychart-beta\n  title "平均距离 (米)"\n  bar [12.4, 15.8, 8.2]\n```\n\n```python\n# fence 内的 <think> 与 [1] 都不是标记\nprint("[1]")\n```',
    META,
  ],
  sources: [SOURCES[0] as (typeof SOURCES)[number]],
  phase: "done",
};

/** The failed overview: the think block opened, then the transport died. */
export const OVERVIEW_ERROR: AiOverviewDebugScenario = {
  id: "ov-error",
  label: "failed state (receipt)",
  q: "AI 回答失败了长什么样",
  chunks: ["<think>正在整理来源…"],
  sources: [],
  phase: "error",
  error: "HTTP 502: the AI stream was cut before any content",
};

export const AI_OVERVIEW_SCENARIOS: AiOverviewDebugScenario[] = [OVERVIEW_STREAMED, OVERVIEW_FENCES, OVERVIEW_ERROR];
