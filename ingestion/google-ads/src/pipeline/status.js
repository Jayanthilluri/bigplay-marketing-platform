// admin.import_log status lifecycle:
//
//   running ──► success   every row loaded, every integrity check passed
//          ├──► partial   data loaded and checks passed, but some rows were
//          │              rejected by staging validation (see error_message)
//          └──► failed    API/auth/database error, or an integrity check
//                         failed (core changes are rolled back)
//
// Terminal states never change again.

export const STATUS = Object.freeze({ RUNNING: 'running', SUCCESS: 'success', PARTIAL: 'partial', FAILED: 'failed' });

const TRANSITIONS = {
  running: new Set(['success', 'partial', 'failed']),
  success: new Set(),
  partial: new Set(),
  failed: new Set(),
};

export function assertTransition(from, to) {
  if (!TRANSITIONS[from]?.has(to)) throw new Error(`Illegal import_log status transition ${from} -> ${to}`);
  return to;
}

export function determineStatus({ fatalError = null, rejected = 0, checks = [] } = {}) {
  if (fatalError) return STATUS.FAILED;
  if (checks.some((c) => !c.passed && c.severity === 'error')) return STATUS.FAILED;
  if (rejected > 0) return STATUS.PARTIAL;
  return STATUS.SUCCESS;
}

/** Compact "reason (count)" summary for admin.import_log.error_message. */
export function summarizeRejections(rejected, limit = 5) {
  const counts = new Map();
  for (const r of rejected) for (const reason of r.reasons) {
    const generic = reason.replace(/\d{4}-\d{2}-\d{2}|"[^"]*"|\b\d+\b/g, '…');
    counts.set(generic, (counts.get(generic) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  return top.map(([reason, n]) => `${reason} (${n})`).join('; ');
}
