import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("api", {
  // Session management
  createSession: (name: string, cwd: string) => ipcRenderer.invoke("session:create", name, cwd),
  killSession: (id: string) => ipcRenderer.invoke("session:kill", id),
  focusSession: (id: string) => ipcRenderer.invoke("session:focus", id),
  getSessions: () => ipcRenderer.invoke("session:list"),
  writeToSession: (id: string, data: string) => ipcRenderer.send("session:write", id, data),
  resizeSession: (id: string, cols: number, rows: number) => ipcRenderer.send("session:resize", id, cols, rows),

  // Workspace management
  getWorkspaces: () => ipcRenderer.invoke("workspace:list"),
  activateWorkspace: (index: number) => ipcRenderer.invoke("workspace:activate", index),

  // Session rename
  renameSession: (id: string, newName: string) => ipcRenderer.invoke("session:rename", id, newName),

  // Config
  getConfig: () => ipcRenderer.invoke("config:get"),

  // Handoff
  triggerHandoff: (id: string) => ipcRenderer.invoke("session:handoff", id),

  // Events from main -> renderer
  onSessionData: (callback: (id: string, data: string) => void) =>
    ipcRenderer.on("session:data", (_e, id, data) => callback(id, data)),
  onSessionExit: (callback: (id: string) => void) =>
    ipcRenderer.on("session:exit", (_e, id) => callback(id)),
  onSessionCreated: (callback: (session: any) => void) =>
    ipcRenderer.on("session:created", (_e, session) => callback(session)),

  // Cleanup
  removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel),
})
