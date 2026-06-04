import { app, BrowserWindow, protocol } from "electron"
import { join } from "path"
import { setupIpc } from "./ipc"

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: "ClaudeTUI",
    backgroundColor: "#0d1117",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
    frame: true,
  })

  setupIpc(mainWindow)

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    const rendererPath = join(__dirname, "../renderer/index.html")
    console.log("Loading renderer from:", rendererPath)
    mainWindow.loadFile(rendererPath)
  }

  // Open DevTools in dev for debugging
  mainWindow.webContents.openDevTools()
}

app.whenReady().then(createWindow)

app.on("window-all-closed", () => {
  app.quit()
})
