import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export interface ThemeConfig {
  fontFamily?: string
  fontSize?: number
  background?: string
  foreground?: string
  cursor?: string
  selectionBackground?: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
}

export interface TuiConfig {
  workspaceScanPaths: string[]
  defaultCommand?: string
  defaultArgs?: string[]
  theme?: ThemeConfig
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
      defaultCommand: data.defaultCommand,
      defaultArgs: data.defaultArgs,
      theme: data.theme,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}
