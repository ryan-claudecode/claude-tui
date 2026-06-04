import { app, BrowserWindow, protocol, Menu } from "electron"
import { join } from "path"
import { setupIpc } from "./ipc"

let mainWindow: BrowserWindow | null = null

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: "ClaudeTUI",
    backgroundColor: "#0d1117",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
    frame: true,
  })

  // setupIpc is async (starts MCP server)
  await setupIpc(mainWindow)

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    const rendererPath = join(__dirname, "../renderer/index.html")
    console.log("Loading renderer from:", rendererPath)
    mainWindow.loadFile(rendererPath)
  }

  // Uncomment to debug: mainWindow.webContents.openDevTools()
}

app.whenReady().then(async () => {
  // Drop the default File/Edit/View/Window menu — none of it is useful here and
  // we'll build our own in-app affordances. (Removes the menu bar on Win/Linux.)
  Menu.setApplicationMenu(null)
  await createWindow()
})

app.on("window-all-closed", () => {
  app.quit()
})
