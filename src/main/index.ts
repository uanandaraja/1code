import { app, BrowserWindow, session, Menu } from "electron"
import { join } from "path"
import { readFileSync, existsSync, unlinkSync, readlinkSync } from "fs"
import * as Sentry from "@sentry/electron/main"
import { initDatabase, closeDatabase } from "./lib/db"
import { serverManager } from "./lib/opencode"
import { createMainWindow, getWindow } from "./windows/main"
import {
  initAnalytics,
  trackAppOpened,
  shutdown as shutdownAnalytics,
} from "./lib/analytics"
import {
  initAutoUpdater,
  checkForUpdates,
  downloadUpdate,
  setupFocusUpdateCheck,
} from "./lib/auto-updater"

// Dev mode detection
const IS_DEV = !!process.env.ELECTRON_RENDERER_URL

// Deep link protocol (must match package.json build.protocols.schemes)
// Use different protocol in dev to avoid conflicts with production app
const PROTOCOL = IS_DEV ? "twentyfirst-agents-dev" : "twentyfirst-agents"

// Set dev mode userData path BEFORE requestSingleInstanceLock()
// This ensures dev and prod have separate instance locks
if (IS_DEV) {
  const { join } = require("path")
  const devUserData = join(app.getPath("userData"), "..", "Agents Dev")
  app.setPath("userData", devUserData)
  console.log("[Dev] Using separate userData path:", devUserData)
}

// Initialize Sentry before app is ready (production only)
if (app.isPackaged && !IS_DEV) {
  const sentryDsn = import.meta.env.MAIN_VITE_SENTRY_DSN
  if (sentryDsn) {
    try {
      Sentry.init({
        dsn: sentryDsn,
      })
      console.log("[App] Sentry initialized")
    } catch (error) {
      console.warn("[App] Failed to initialize Sentry:", error)
    }
  } else {
    console.log("[App] Skipping Sentry initialization (no DSN configured)")
  }
} else {
  console.log("[App] Skipping Sentry initialization (dev mode)")
}

// URL configuration (exported for use in other modules)
// In packaged app, ALWAYS use production URL to prevent localhost leaking into releases
// In dev mode, allow override via MAIN_VITE_API_URL env variable
export function getBaseUrl(): string {
  if (app.isPackaged) {
    return "https://21st.dev"
  }
  return import.meta.env.MAIN_VITE_API_URL || "https://21st.dev"
}

export function getAppUrl(): string {
  return process.env.ELECTRON_RENDERER_URL || "https://21st.dev/agents"
}

// Register protocol BEFORE app is ready

/**
 * Register the app as the handler for our custom protocol.
 * On macOS, this may not take effect immediately on first install -
 * Launch Services caches protocol handlers and may need time to update.
 */
function registerProtocol(): boolean {
  let success = false

  if (process.defaultApp) {
    // Dev mode: need to pass execPath and script path
    if (process.argv.length >= 2) {
      success = app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
        process.argv[1]!,
      ])
    }
  } else {
    // Production mode
    success = app.setAsDefaultProtocolClient(PROTOCOL)
  }

  return success
}

// Store initial registration result (set in app.whenReady())
let initialRegistration = false

// Verify registration (this checks if OS recognizes us as the handler)
function verifyProtocolRegistration(): void {
  // Verification is done silently - registration issues will be apparent if deep links don't work
}

// Clean up stale lock files from crashed instances
// Returns true if locks were cleaned, false otherwise
function cleanupStaleLocks(): boolean {
  const userDataPath = app.getPath("userData")
  const lockPath = join(userDataPath, "SingletonLock")

  if (!existsSync(lockPath)) return false

  try {
    // SingletonLock is a symlink like "hostname-pid"
    const lockTarget = readlinkSync(lockPath)
    const match = lockTarget.match(/-(\d+)$/)
    if (match) {
      const pid = parseInt(match[1], 10)
      try {
        // Check if process is running (signal 0 doesn't kill, just checks)
        process.kill(pid, 0)
        // Process exists, lock is valid
        return false
      } catch {
        // Process doesn't exist, clean up stale locks
        const filesToRemove = ["SingletonLock", "SingletonSocket", "SingletonCookie"]
        for (const file of filesToRemove) {
          const filePath = join(userDataPath, file)
          if (existsSync(filePath)) {
            try {
              unlinkSync(filePath)
            } catch (e) {
              console.warn("[App] Failed to remove", file, e)
            }
          }
        }
        return true
      }
    }
  } catch (e) {
    console.warn("[App] Failed to check lock file:", e)
  }
  return false
}

// Prevent multiple instances
let gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  // Maybe stale lock - try cleanup and retry once
  const cleaned = cleanupStaleLocks()
  if (cleaned) {
    gotTheLock = app.requestSingleInstanceLock()
  }
  if (!gotTheLock) {
    app.quit()
  }
}

if (gotTheLock) {
  // Handle second instance launch
  app.on("second-instance", (_event, _commandLine) => {
    const window = getWindow()
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })

  // App ready
  app.whenReady().then(async () => {
    // Set dev mode app name (userData path was already set before requestSingleInstanceLock)
    if (IS_DEV) {
      app.name = "Agents Dev"
    }

    // Register protocol handler (must be after app is ready)
    initialRegistration = registerProtocol()

    // Set app user model ID for Windows (different in dev to avoid taskbar conflicts)
    if (process.platform === "win32") {
      app.setAppUserModelId(IS_DEV ? "dev.21st.1code.dev" : "dev.21st.1code")
    }

    console.log(`[App] Starting 1Code${IS_DEV ? " (DEV)" : ""}...`)

    // Verify protocol registration after app is ready
    // This helps diagnose first-install issues where the protocol isn't recognized yet
    verifyProtocolRegistration()

    // Get Claude Code version for About panel
    let claudeCodeVersion = "unknown"
    try {
      const isDev = !app.isPackaged
      const versionPath = isDev
        ? join(app.getAppPath(), "resources/bin/VERSION")
        : join(process.resourcesPath, "bin/VERSION")

      if (existsSync(versionPath)) {
        const versionContent = readFileSync(versionPath, "utf-8")
        claudeCodeVersion = versionContent.split("\n")[0]?.trim() || "unknown"
      }
    } catch (error) {
      console.warn("[App] Failed to read Claude Code version:", error)
    }

    // Set About panel options with Claude Code version
    app.setAboutPanelOptions({
      applicationName: "1Code",
      applicationVersion: app.getVersion(),
      version: `Claude Code ${claudeCodeVersion}`,
      copyright: "Copyright © 2026 21st.dev",
    })

    // Track update availability for menu
    let updateAvailable = false
    let availableVersion: string | null = null

    // Function to build and set application menu
    const buildMenu = () => {
      const template: Electron.MenuItemConstructorOptions[] = [
        {
          label: app.name,
          submenu: [
            { role: "about", label: "About 1Code" },
            {
              label: updateAvailable
                ? `Update to v${availableVersion}...`
                : "Check for Updates...",
              click: () => {
                // Send event to renderer to clear dismiss state
                const win = getWindow()
                if (win) {
                  win.webContents.send("update:manual-check")
                }
                // If update is already available, start downloading immediately
                if (updateAvailable) {
                  downloadUpdate()
                } else {
                  checkForUpdates(true)
                }
              },
            },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        {
          label: "File",
          submenu: [
            {
              label: "New Chat",
              accelerator: "CmdOrCtrl+N",
              click: () => {
                const win = getWindow()
                if (win) {
                  win.webContents.send("shortcut:new-agent")
                }
              },
            },
          ],
        },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        {
          label: "View",
          submenu: [
            { role: "reload" },
            { role: "forceReload" },
            { role: "toggleDevTools" },
            { type: "separator" },
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { type: "separator" },
            { role: "togglefullscreen" },
          ],
        },
        {
          label: "Window",
          submenu: [
            { role: "minimize" },
            { role: "zoom" },
            { type: "separator" },
            { role: "front" },
          ],
        },
        {
          role: "help",
          submenu: [
            {
              label: "Learn More",
              click: async () => {
                const { shell } = await import("electron")
                await shell.openExternal("https://21st.dev")
              },
            },
          ],
        },
      ]
      Menu.setApplicationMenu(Menu.buildFromTemplate(template))
    }

    // Set update state and rebuild menu
    const setUpdateAvailable = (available: boolean, version?: string) => {
      updateAvailable = available
      availableVersion = version || null
      buildMenu()
    }

    // Expose setUpdateAvailable globally for auto-updater
    ;(global as any).__setUpdateAvailable = setUpdateAvailable

    // Build initial menu
    buildMenu()

    // Initialize analytics
    initAnalytics()

    // Track app opened
    trackAppOpened()

    // Initialize database
    try {
      initDatabase()
      console.log("[App] Database initialized")
    } catch (error) {
      console.error("[App] Failed to initialize database:", error)
    }

    // Initialize OpenCode server (multi-provider AI backend)
    try {
      await serverManager.start()
      console.log("[App] OpenCode server started")
    } catch (error) {
      console.error("[App] Failed to start OpenCode server:", error)
      // Non-fatal - app can still work with Claude SDK fallback
    }

    // Create main window
    createMainWindow()

    // Initialize auto-updater (production only)
    if (app.isPackaged) {
      await initAutoUpdater(getWindow)
      // Setup update check on window focus (instead of periodic interval)
      setupFocusUpdateCheck(getWindow)
      // Check for updates 5 seconds after startup (force to bypass interval check)
      setTimeout(() => {
        checkForUpdates(true)
      }, 5000)
    }

    // macOS: Re-create window when dock icon is clicked
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
      }
    })
  })

  // Quit when all windows are closed (except on macOS)
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit()
    }
  })

  // Cleanup before quit
  app.on("before-quit", async () => {
    console.log("[App] Shutting down...")
    await serverManager.shutdown()
    await shutdownAnalytics()
    await closeDatabase()
  })

  // Handle uncaught exceptions
  process.on("uncaughtException", (error) => {
    console.error("[App] Uncaught exception:", error)
  })

  process.on("unhandledRejection", (reason, promise) => {
    console.error("[App] Unhandled rejection at:", promise, "reason:", reason)
  })
}
