/**
 * JSON reporter — minimal pass-through (Phase 7 stub).
 *
 * The canonical machine-readable shape is the `AuditReport` itself; this
 * reporter just serializes it. Phase 9 will enhance with a stable schema
 * version field for CI consumers.
 */

import type { AuditReport } from "../types";

export function renderJson(report: AuditReport): string {
  return JSON.stringify(report, null, 2);
}
