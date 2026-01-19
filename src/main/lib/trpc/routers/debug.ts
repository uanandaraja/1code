import { router, publicProcedure } from "../index"
import { getDatabase, projects, chats, subChats } from "../../db"
import { app, shell } from "electron"

// Protocol constant (must match main/index.ts)
const IS_DEV = !!process.env.ELECTRON_RENDERER_URL
const PROTOCOL = IS_DEV ? "twentyfirst-agents-dev" : "twentyfirst-agents"

export const debugRouter = router({
  /**
   * Get system information for debug display
   */
  getSystemInfo: publicProcedure.query(() => {
    // Check protocol registration
    let protocolRegistered = false
    try {
      protocolRegistered = process.defaultApp
        ? app.isDefaultProtocolClient(
            PROTOCOL,
            process.execPath,
            [process.argv[1]!],
          )
        : app.isDefaultProtocolClient(PROTOCOL)
    } catch {
      protocolRegistered = false
    }

    return {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      isDev: IS_DEV,
      userDataPath: app.getPath("userData"),
      protocolRegistered,
    }
  }),

  /**
   * Get database statistics
   */
  getDbStats: publicProcedure.query(() => {
    const db = getDatabase()
    const projectCount = db.select().from(projects).all().length
    const chatCount = db.select().from(chats).all().length
    const subChatCount = db.select().from(subChats).all().length

    return {
      projects: projectCount,
      chats: chatCount,
      subChats: subChatCount,
    }
  }),

  /**
   * Clear all chats and sub-chats (keeps projects)
   */
  clearChats: publicProcedure.mutation(() => {
    const db = getDatabase()
    // Delete sub_chats first (foreign key constraint)
    db.delete(subChats).run()
    db.delete(chats).run()
    return { success: true }
  }),

  /**
   * Clear all data (projects, chats, sub-chats)
   */
  clearAllData: publicProcedure.mutation(() => {
    const db = getDatabase()
    // Delete in order due to foreign key constraints
    db.delete(subChats).run()
    db.delete(chats).run()
    db.delete(projects).run()
    return { success: true }
  }),

  /**
   * Open userData folder in system file manager
   */
  openUserDataFolder: publicProcedure.mutation(() => {
    const userDataPath = app.getPath("userData")
    shell.openPath(userDataPath)
    return { success: true }
  }),
})
