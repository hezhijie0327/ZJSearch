// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

import { useState } from "react";
import { type CalculationAnswer, tryEvaluateExpression } from "@/features/calculator.ts";

/** Interactive calculator for the "calculator" plugin: the query-detected
    expression seeds the display and the keypad keeps evaluating live, like
    the Google/DDG calculator cards. */
export function CalculatorAnswer({ calc }: { calc: CalculationAnswer }) {
  const [expression, setExpression] = useState(calc.expr);
  const result = tryEvaluateExpression(expression);
  const press = (key: string) => {
    setExpression((prev) => prev + key);
  };
  const keys: Array<{
    label: string;
    insert?: string;
    span?: string;
    kind?: "op" | "eq";
    action?: () => void;
  }> = [
    { label: "AC", action: () => setExpression("") },
    { label: "⌫", action: () => setExpression((prev) => prev.slice(0, -1)) },
    { label: "(", insert: "(" },
    { label: ")", insert: ")" },
    { label: "÷", insert: "/", kind: "op" },
    { label: "7", insert: "7" },
    { label: "8", insert: "8" },
    { label: "9", insert: "9" },
    { label: "×", insert: "*", kind: "op" },
    { label: "^", insert: "^", kind: "op" },
    { label: "4", insert: "4" },
    { label: "5", insert: "5" },
    { label: "6", insert: "6" },
    { label: "−", insert: "-", kind: "op" },
    { label: "%", insert: "%", kind: "op" },
    { label: "1", insert: "1" },
    { label: "2", insert: "2" },
    { label: "3", insert: "3" },
    { label: "+", insert: "+", kind: "op" },
    { label: "=", kind: "eq" },
    { label: "0", insert: "0", span: "col-span-3" },
    { label: ".", insert: "." },
  ];
  return (
    // no source url → uncarded answer tier (gray expression, 4xl value,
    // border-b divider), the keypad follows beneath
    <div className="animate-fade-up border-b border-line px-4 pb-3">
      <div className="rounded-xl bg-surface-2/60 px-4 py-2 text-end">
        <p className="truncate font-mono text-xs text-ink-3" dir="ltr">
          {expression}
          {result ? " =" : ""}
        </p>
        <p className="min-h-10 truncate text-4xl font-semibold tabular-nums text-ink" dir="ltr">
          {result ? result.value : ""}
        </p>
      </div>
      <div className="mt-3 grid grid-cols-5 gap-2">
        {keys.map((key) => (
          <button
            className={`h-11 rounded-xl text-sm transition-colors ${
              key.kind === "eq"
                ? "row-span-2 bg-accent-strong text-base text-accent-contrast hover:bg-accent-strong-hover"
                : key.kind === "op"
                  ? "bg-surface-2 text-accent hover:bg-line/40"
                  : "bg-surface-2 text-ink hover:bg-line/40"
            } ${key.span ?? ""}`}
            key={key.label}
            onClick={() => {
              if (key.action) {
                key.action();
              } else if (key.insert) {
                press(key.insert);
              }
            }}
            type="button"
          >
            {key.label}
          </button>
        ))}
      </div>
    </div>
  );
}
