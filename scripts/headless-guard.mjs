// Headless dispatch guard. Pure, dependency-free — safe to import from vitest
// (unlike scheduler-tick.mjs, which transitively pulls in node:sqlite).
//
// Every dashboard/orchestrator dispatch prompt already carries a non-interactive
// declaration. Scheduled runbooks are the one dispatch surface that does NOT:
// scripts/scheduler-tick.mjs spawns `schedule.prompt` verbatim and the seed
// runbooks are bare (`/os brief` etc.). appendHeadlessGuard closes that gap at
// the single spawn site — the guard is a dispatch-layer envelope, not runbook
// content, so the prompt recorded to the run log stays as authored.

// The canonical marker. Carries the load-bearing "Do NOT use AskUserQuestion"
// phrase every other dispatch surface uses, plus the pointer to each gate's
// declared Headless: policy (see standard-skill-format § "Headless behavior").
export const HEADLESS_GUARD =
  'This is a scheduled headless run — Do NOT use AskUserQuestion or any interactive prompt. ' +
  "Follow each gate's declared Headless: policy (default / park / refuse).";

// Idempotent: the guard's own text matches this regex, so a double-append is a
// no-op, and any prompt that already declares itself non-interactive is left
// untouched.
const ALREADY_HEADLESS = /do not use askuserquestion/i;

export function appendHeadlessGuard(prompt) {
  const text = prompt ?? '';
  if (ALREADY_HEADLESS.test(text)) return text;
  return `${text}\n\n${HEADLESS_GUARD}`;
}
