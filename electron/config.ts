import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export interface TuiConfig {
  workspaceScanPaths: string[]
}

const CONFIG_DIR = join(homedir(), ".claude-tui")
const CONFIG_FILE = join(CONFIG_DIR, "config.json")

const DEFAULT_CONFIG: TuiConfig = {
  workspaceScanPaths: [
    join(homedir(), "workspaces", "ws-*"),
  ],
}

export function loadConfig(): TuiConfig {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8")
    const data = JSON.parse(raw)
    return {
      workspaceScanPaths: data.workspaceScanPaths ?? DEFAULT_CONFIG.workspaceScanPaths,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}
