// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/**
 * Client-side calculator answer for the "calculator" server plugin: when the
 * query is a plain arithmetic expression, evaluate it and append an answer.
 * Only digits and basic operators survive the sanitizer, so no arbitrary
 * input ever reaches the evaluator.
 */

export interface CalculationAnswer {
  expr: string;
  value: number;
}

export function tryEvaluateExpression(rawQuery: string): CalculationAnswer | null {
  const expr = rawQuery
    .trim()
    .replace(/[=?=\s]+$/, "")
    .trim();
  if (expr.length === 0 || expr.length > 80) {
    return null;
  }
  // must contain at least one digit and one operator, nothing but numbers/operators
  if (!/[0-9]/.test(expr) || !/[+\-*/^%]/.test(expr)) {
    return null;
  }
  if (!/^[0-9+\-*/().,%^ ]+$/.test(expr)) {
    return null;
  }
  const js = expr.replace(/\^/g, "**").replace(/,/g, "");
  try {
    // input is sanitized to arithmetic characters above — Function() is the
    // sanctioned escape hatch here (no JS parser dependency for one feature)
    const value = Function(`"use strict"; return (${js});`)();
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    return { expr, value: Math.round(value * 1e10) / 1e10 };
  } catch {
    return null;
  }
}
