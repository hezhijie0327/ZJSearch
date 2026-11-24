// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { base, call, calls, INVENTORY, settled, sourceBook, usage } from "@/features/results/aiSearch/debug/shared.ts";
import type { DebugScenario } from "@/features/results/aiSearch/debug/types.ts";

const QUESTION = "三种纸飞机折法的距离与滞空对比";
const S = sourceBook();

/** Search rows in every settle state (ok · error · duplicate), the
    engine inventory, tool discovery, history recall and the plan write --
    and the LEDGERS they feed: findings (active / superseded / conflict,
    with tags), an open gap, the plan with per-task sources and a task left
    `pending` at the settle -- the plan card keeps the model's last snapshot. */
export const SEARCH_STAGE: DebugScenario = {
  id: "search",
  name: "检索与台账",
  label: "search rows × states · inventory · discovery · recall · ledgers",
  q: QUESTION,
  mode: "balanced",
  events: [
    { e: "client.start", runNo: 1, q: QUESTION, mode: "balanced" },
    { ...base },
    { e: "phase", name: "plan" },
    { e: "say", id: 1, t: "拆成折法、纸张两条线,先把实测数据找齐;顺手看一眼引擎清单。" },
    { e: "think", id: 1, t: "距离和滞空要来自同一批实测,口径才可比。" },
    calls(
      [
        call(1, "search_web", "纸飞机 折法 距离 滞空 对比", { query: "纸飞机 折法 距离 滞空 对比" }),
        call(2, "search_web", "A4 纸 克重 飞行距离", { query: "A4 纸 克重 飞行距离", category: "news" }),
        call(3, "search_web", "paper plane fold glide ratio", { query: "paper plane fold glide ratio" }),
        call(4, "search_web", "纸飞机 滑翔形 距离", { query: "纸飞机 滑翔形 距离" }),
        call(5, "list_engines", "", {}),
        call(6, "mcp", "engine inventory", { query: "engine inventory" }, "search_tools"),
        call(7, "recall_history", "折法 实测", { query: "折法 实测" }),
        call(8, "update_plan", "2/4", {
          items: [
            { title: "折法对比:距离与滞空", status: "active" },
            { title: "纸张与投掷角度", status: "active" },
            { title: "往届成绩的口径", status: "done" },
            { title: "比赛日风险与备选方案", status: "pending" },
          ],
        }),
      ],
      1,
    ),
    S.join({ round: 1, id: 1 }, "folds", "weight", "records"),
    {
      e: "call",
      id: 1,
      call: 1,
      status: "ok",
      n: 5,
      ms: 2395,
      feed: `plan: 5 deep + 5 shallow lines ${S.cite("folds", "weight")}…`,
    },
    {
      e: "call",
      id: 1,
      call: 2,
      status: "ok",
      n: 8,
      ms: 1870,
      feed: `plan: 5 deep + 5 shallow lines ${S.cite("records")}…`,
    },
    { e: "call", id: 1, call: 3, status: "error", ms: 3210, feed: "error: the search failed" },
    S.join({ round: 1, id: 1 }, "venue"),
    {
      e: "call",
      id: 1,
      call: 4,
      status: "duplicate",
      ms: 900,
      dupes: [S.number("folds")],
      feed: `duplicate: all hits already numbered ${S.cite("folds")}`,
    },
    {
      e: "call",
      id: 1,
      call: 5,
      status: "ok",
      n: INVENTORY.total,
      ms: 3,
      inventory: INVENTORY,
      feed: 'This demo deployment searches 48 enabled engines across 8 categories:\n  general (12) · images (8) · news (6) · …\nDisabled engines (2) -- a bang prefix still reaches them, e.g. "!shortcut keywords":\n  demo.paid (bang: demo) -- general\n  …',
    },
    {
      e: "call",
      id: 1,
      call: 6,
      status: "ok",
      n: 2,
      ms: 3,
      feed: '[{"name":"list_engines","server":"","description":"List the search ENGINES this deployment carries","inputSchema":{"type":"object","properties":{},"required":[]},"instructions":"Consult it ONCE, and only when it can change a decision."}]',
      tools: [
        {
          name: "list_engines",
          server: "",
          description:
            "List the search ENGINES this deployment carries: the enabled ones grouped by category, and the engines kept disabled by default -- still reachable by their bang.",
          params: [],
          required: [],
          instructions:
            "Consult it ONCE, and only when it can change a decision: when unsure which vertical fits, when searches keep coming back thin or empty, or before relying on a niche vertical.",
        },
        {
          name: "demo_maps_geo",
          server: "demo-maps",
          description: "Resolve an address to its district (geocoding).",
          params: ["address"],
          required: ["address"],
          instructions: "结果含国家、省、市、区与坐标。",
        },
      ],
    },
    {
      e: "call",
      id: 1,
      call: 7,
      status: "ok",
      n: 3,
      ms: 12,
      preview: "- 滑翔形折法实测:距离 15.8 米\n- 投掷角度实验记录\n- 去年比赛成绩",
    },
    {
      e: "call",
      id: 1,
      call: 8,
      status: "ok",
      ms: 412,
      feed: "plan written: 2/4 subtasks covered. Search each subtask's keywords; when a subtask's evidence is sufficient, mark it done.",
    },
    {
      e: "plan",
      items: [
        { title: "折法对比:距离与滞空", status: "active", sources: [S.number("folds"), S.number("records")] },
        { title: "纸张与投掷角度", status: "active", sources: [S.number("weight")] },
        { title: "往届成绩的口径", status: "done", sources: [S.number("records")] },
        { title: "比赛日风险与备选方案", status: "pending" },
      ],
    },
    {
      e: "findings",
      items: [
        {
          id: 1,
          text: `滑翔形的平均滞空时间为 **6.4 秒**,在三种折法里最长${S.cite("folds")}。`,
          refs: [S.number("folds")],
          tags: ["折法", "滞空"],
          status: "active",
          round: 1,
        },
        {
          id: 2,
          text: `早期草案:滑翔形平均飞行距离约 10 米${S.cite("records")}。`,
          refs: [S.number("records")],
          tags: ["折法", "距离"],
          status: "superseded",
          round: 1,
        },
        {
          id: 3,
          text: `另一份记录里滑翔形只飞了 14.0 米${S.cite("records")},与 ${S.cite("folds")} 的投掷口径明显不一致。`,
          refs: [S.number("records")],
          tags: ["折法", "距离"],
          status: "active",
          round: 1,
          conflict_with: 1,
        },
        {
          id: 4,
          text: `80g 纸比 70g 纸平均多飞 1.8 米${S.cite("weight")}。`,
          refs: [S.number("weight")],
          tags: ["纸张", "距离"],
          status: "active",
          round: 1,
        },
      ],
      gaps: [
        {
          id: 1,
          q: "特技形在有风条件下的稳定性数据",
          why: "体育馆门口的风会影响回旋动作",
          status: "open",
        },
      ],
    },
    { e: "close", id: 1 },
    { e: "open", id: 2, kind: "write", round: 0 },
    { e: "phase", name: "write" },
    {
      e: "answer",
      t: `三种折法里**滑翔形**最均衡:平均飞行 **15.8 米**、滞空 6.4 秒${S.cite("folds")};镖形出手快但落地早,特技形胜在稳定${S.cite("folds")}。往届成绩里有一份 14.0 米的记录,那是顺风场地的数字,不能直接拿来比${S.cite("records")}。`,
    },
    { e: "close", id: 2 },
    { e: "related", items: ["80g 纸会不会太重影响出手?", "特技形怎么折才能回旋?"] },
    settled(usage(12400, 620, 520, 6030)),
  ],
};
