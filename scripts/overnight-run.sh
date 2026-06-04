#!/bin/bash
# ClaudeTUI Overnight Autonomous Runner
# Spawns sequential Claude sessions that work through the implementation plan.
# Each session checks git log to see what's done, picks up the next task.
# Runs for 4-6 hours (configurable).

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

MIN_HOURS=4
MAX_HOURS=6
MIN_SECONDS=$((MIN_HOURS * 3600))
MAX_SECONDS=$((MAX_HOURS * 3600))
START_TIME=$(date +%s)
SESSION_COUNT=0
PLAN_FILE="docs/superpowers/plans/2026-06-03-rich-panels.md"
MODEL="claude-opus-4-8"
LOG_FILE="$PROJECT_DIR/logs/overnight-$(date +%Y%m%d-%H%M%S).log"

mkdir -p "$PROJECT_DIR/logs"

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

should_continue() {
  local elapsed=$(elapsed_seconds)
  if [ $elapsed -gt $MAX_SECONDS ]; then
    log "Max time reached (${MAX_HOURS}h). Stopping."
    return 1
  fi
  return 0
}

log "=== ClaudeTUI Overnight Run Started ==="
log "Project: $PROJECT_DIR"
log "Model: $MODEL"
log "Min runtime: ${MIN_HOURS}h, Max runtime: ${MAX_HOURS}h"
log "Plan: $PLAN_FILE"
log "Log: $LOG_FILE"
log ""

while should_continue; do
  SESSION_COUNT=$((SESSION_COUNT + 1))
  ELAPSED=$(elapsed_seconds)
  REMAINING=$((MAX_SECONDS - ELAPSED))

  log "--- Session #$SESSION_COUNT starting (elapsed: $(elapsed_human), remaining: $((REMAINING/60))m) ---"

  # Get recent git history for context
  RECENT_COMMITS=$(git log --oneline -20 2>/dev/null || echo "No commits yet")

  PROMPT="You are an autonomous developer working on ClaudeTUI, a cross-platform Electron desktop app for managing Claude Code sessions.

PROJECT: $PROJECT_DIR
PLAN: $PLAN_FILE

## What's been done (recent commits):
$RECENT_COMMITS

## Your instructions:

1. Read the CLAUDE.md file for project architecture.
2. Read the plan at $PLAN_FILE.
3. Check the git log above to see what's already been completed.
4. Pick up the NEXT uncompleted task. Phase 0 (testing infrastructure) is done. If you're unsure what's done, check if the files/features from each task exist.
5. Implement the task following the plan's instructions.
6. After each task:
   - Build: npx electron-vite build
   - If build fails, fix the errors before committing
   - Commit with a descriptive message
   - Push: git push
7. Move to the next task and repeat.

## Testing
- To visually test: build, then launch with 'npx electron . &', use MCP tools (take_screenshot, get_app_state), then kill with 'taskkill //F //IM electron.exe'
- The MCP config is at /tmp/claudetui/mcp-config.json
- Always verify builds pass before committing

## When you've completed all Phase 1-4 tasks
Move to Phase 5 (Creative Features). Read the Phase 5 section of the plan for inspiration. Build features that make ClaudeTUI stand out. Follow the 4-step pattern (service → IPC → MCP → UI) for each feature. Be creative and ambitious.

## Session management
- You have approximately $((REMAINING/60)) minutes remaining in the overall run.
- Work efficiently. Complete 2-4 tasks per session.
- When you've completed several tasks and your context is getting large, exit cleanly so a fresh session can continue.
- DO NOT spend excessive time on any single task. If stuck for more than 10 minutes, skip and move on.

## Code quality
- Follow existing patterns in the codebase
- DRY — extract shared logic into services
- Every new feature: service → IPC → MCP tool → preload → UI
- Commit after each completed task
- Push after each commit"

  # Run Claude session
  claude --dangerously-skip-permissions --model "$MODEL" "$PROMPT" 2>&1 | tee -a "$LOG_FILE" || true

  log "Session #$SESSION_COUNT ended."

  # Brief pause between sessions
  sleep 10

  # Check minimum time — if we've been running long enough and there's nothing left, we can stop
  ELAPSED=$(elapsed_seconds)
  if [ $ELAPSED -gt $MIN_SECONDS ]; then
    # Check if Phase 5 creative features have been started (indication main work is done)
    PHASE5_COMMITS=$(git log --oneline --all | grep -ci "creative\|phase.5\|notification\|command.palette\|timeline\|git.integration" || true)
    if [ "$PHASE5_COMMITS" -gt 3 ]; then
      log "Minimum time reached and Phase 5 well underway. Good stopping point."
      # Continue anyway — let it keep being creative until max time
    fi
  fi
done

TOTAL_ELAPSED=$(elapsed_human)
TOTAL_COMMITS=$(git log --oneline | head -50 | wc -l)

log ""
log "=== Overnight Run Complete ==="
log "Total time: $TOTAL_ELAPSED"
log "Total sessions: $SESSION_COUNT"
log "Recent commits: $TOTAL_COMMITS"
log "Log saved to: $LOG_FILE"

# Final summary
log ""
log "Commits made during this run:"
git log --oneline --since="$(($(date +%s) - $(elapsed_seconds))) seconds ago" 2>/dev/null | tee -a "$LOG_FILE" || true
