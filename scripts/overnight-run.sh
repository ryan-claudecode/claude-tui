#!/bin/bash
# ClaudeTUI Overnight Autonomous Runner
# Spawns sequential Claude sessions, each completing 1-3 tasks.
# Uses --print mode for clean exit after each chunk of work.

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

MAX_HOURS=6
MAX_SECONDS=$((MAX_HOURS * 3600))
START_TIME=$(date +%s)
SESSION_COUNT=0
MODEL="claude-opus-4-8"
LOG_FILE="$PROJECT_DIR/logs/overnight-$(date +%Y%m%d-%H%M%S).log"

# --- Watchdog config ---
# Hard cap on a single session. Prevents one internally-hung session from
# blocking the whole loop (the cause of the ~2h45m dead gap in the first run).
SESSION_TIMEOUT_MIN=12
# Abort the run after this many consecutive sessions produce no new commit —
# catches systemic stalls (e.g. hitting the usage limit, where sessions exit
# instantly and the loop would otherwise spin uselessly).
MAX_NO_COMMIT_STREAK=3
NO_COMMIT_STREAK=0

mkdir -p "$PROJECT_DIR/logs"

# `timeout` ships with git-bash/coreutils; warn (don't fail) if it's missing.
if command -v timeout >/dev/null 2>&1; then
  WATCHDOG="enabled (${SESSION_TIMEOUT_MIN}m/session)"
else
  WATCHDOG="DISABLED (timeout not found — sessions can hang indefinitely)"
fi

log() {
  echo "[$(date '+%H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

elapsed_seconds() {
  echo $(( $(date +%s) - START_TIME ))
}

elapsed_human() {
  local s=$(elapsed_seconds)
  printf '%dh %dm %ds' $((s/3600)) $((s%3600/60)) $((s%60))
}

log "=== ClaudeTUI Overnight Run Started ==="
log "Project: $PROJECT_DIR"
log "Model: $MODEL"
log "Max runtime: ${MAX_HOURS}h"
log "Watchdog: $WATCHDOG"
log "Log: $LOG_FILE"

while true; do
  ELAPSED=$(elapsed_seconds)
  if [ $ELAPSED -gt $MAX_SECONDS ]; then
    log "Max time reached. Stopping."
    break
  fi

  SESSION_COUNT=$((SESSION_COUNT + 1))
  REMAINING=$((MAX_SECONDS - ELAPSED))

  log ""
  log "--- Session #$SESSION_COUNT (elapsed: $(elapsed_human), remaining: $((REMAINING/60))m) ---"

  # Get what's been done
  RECENT_COMMITS=$(git log --oneline -15 2>/dev/null)
  LAST_COMMIT_MSG=$(git log --oneline -1 2>/dev/null)

  # Build the prompt — focused, actionable, explicit about pushing
  PROMPT="You are an autonomous developer working on ClaudeTUI (~/projects/claude-tui-app).

READ FIRST:
- CLAUDE.md for architecture
- docs/superpowers/plans/2026-06-03-rich-panels.md for the full plan

RECENT COMMITS (to know what's done):
$RECENT_COMMITS

YOUR JOB THIS SESSION:
1. Figure out what's the NEXT uncompleted task in the plan (Phase 0 is done)
2. Implement it
3. Build: npx electron-vite build
4. Fix any build errors
5. Commit AND PUSH: git add -A && git commit -m 'descriptive message' && git push
6. If time allows, do the next task too (up to 3 tasks per session)
7. Exit when done

IMPORTANT:
- You MUST push after each commit. This is authorized. Do not ask for confirmation.
- Follow the 4-step pattern: service → IPC → MCP tool → UI
- Keep code DRY and scalable
- If a task needs npm packages, install with: npm install <pkg> --legacy-peer-deps
- If stuck on a task for more than 5 minutes, skip it and move to the next one

ALSO: After completing the panel system tasks, do a FULL UI OVERHAUL. The app should look modern, polished, and elevated — like a premium developer tool. Keep the terminal aesthetic but make it beautiful. Think: refined typography, subtle gradients, micro-animations, glass-morphism effects, proper spacing hierarchy. Update App.css comprehensively."

  log "Prompt sent. Waiting for Claude..."

  # Capture this session's output so we can inspect it (e.g. for a usage-limit
  # message) while still streaming it live to the terminal and the log file.
  SESSION_OUT=$(mktemp)

  # Run in print mode, wrapped in a per-session timeout watchdog. If the session
  # hangs past SESSION_TIMEOUT_MIN, timeout SIGTERMs it (then SIGKILL after a
  # 30s grace period) so the loop never blocks indefinitely. Exit code 124 means
  # it was killed by the watchdog.
  set +e
  if command -v timeout >/dev/null 2>&1; then
    timeout --kill-after=30s "${SESSION_TIMEOUT_MIN}m" \
      claude --dangerously-skip-permissions --model "$MODEL" -p "$PROMPT" 2>&1 \
      | tee -a "$LOG_FILE" "$SESSION_OUT"
  else
    claude --dangerously-skip-permissions --model "$MODEL" -p "$PROMPT" 2>&1 \
      | tee -a "$LOG_FILE" "$SESSION_OUT"
  fi
  EXIT_CODE=${PIPESTATUS[0]}
  set -e

  if [ "$EXIT_CODE" -eq 124 ] || [ "$EXIT_CODE" -eq 137 ]; then
    log "WARNING: Session #$SESSION_COUNT exceeded ${SESSION_TIMEOUT_MIN}m — killed by watchdog."
  fi

  log "Session #$SESSION_COUNT ended."
  log "Last commit: $(git log --oneline -1 2>/dev/null)"

  # Bail out immediately if we hit the usage limit — otherwise the loop would
  # spin firing sessions that all exit instantly (what happened at ~04:35).
  if grep -qiE "hit your limit|usage limit|rate limit|limit reached" "$SESSION_OUT"; then
    log "Usage limit detected. Stopping run (would otherwise spin uselessly)."
    rm -f "$SESSION_OUT"
    break
  fi
  rm -f "$SESSION_OUT"

  # Track consecutive no-progress sessions and abort if we stall systemically.
  NEW_LAST=$(git log --oneline -1 2>/dev/null)
  if [ "$NEW_LAST" = "$LAST_COMMIT_MSG" ]; then
    NO_COMMIT_STREAK=$((NO_COMMIT_STREAK + 1))
    log "WARNING: No new commits this session (streak: $NO_COMMIT_STREAK/$MAX_NO_COMMIT_STREAK)."
    if [ "$NO_COMMIT_STREAK" -ge "$MAX_NO_COMMIT_STREAK" ]; then
      log "No progress for $MAX_NO_COMMIT_STREAK consecutive sessions. Stopping run."
      break
    fi
  else
    NO_COMMIT_STREAK=0
  fi

  sleep 5
done

log ""
log "=== Overnight Run Complete ==="
log "Total time: $(elapsed_human)"
log "Total sessions: $SESSION_COUNT"
log ""
log "All commits during run:"
git log --oneline --since="$(date -d "@$START_TIME" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -r "$START_TIME" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo '6 hours ago')" 2>/dev/null | tee -a "$LOG_FILE" || true
