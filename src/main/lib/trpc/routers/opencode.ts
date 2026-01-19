import { z } from "zod"
import { observable } from "@trpc/server/observable"
import { router, publicProcedure } from "../index"
import { serverManager, createOpenCodeTransformer, transformSessionMessages, type OpenCodeEvent, type UIMessageChunk } from "../../opencode"

// Track active sessions for cancellation
const activeSessions = new Map<string, { abort: () => void; sessionId: string | null }>()

export const opencodeRouter = router({
  /**
   * Main chat subscription - sends prompt and streams responses
   */
  chat: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        subChatId: z.string(),
        prompt: z.string(),
        cwd: z.string(),
        mode: z.enum(["agent", "plan"]).optional().default("agent"),
        sessionId: z.string().optional(),
        projectPath: z.string().optional(),
        // Provider selection (OpenCode supports multiple providers)
        provider: z.string().optional(), // "anthropic", "openai", "google", etc.
        model: z.string().optional(), // "claude-sonnet-4-20250514", "gpt-4o", etc.
        // Images (for multi-modal)
        images: z
          .array(
            z.object({
              mediaType: z.string(),
              base64Data: z.string(),
              filename: z.string().optional(),
            })
          )
          .optional(),
      })
    )
    .subscription(({ input }) => {
      return observable<UIMessageChunk>((emit) => {
        const abortController = new AbortController()
        let eventUnsubscribe: (() => void) | null = null
        let currentSessionId: string | null = input.sessionId || null

        // Store for cancellation
        activeSessions.set(input.subChatId, {
          abort: () => abortController.abort(),
          sessionId: currentSessionId,
        })

        const run = async () => {
          try {
            const client = serverManager.getClient()
            if (!client) {
              emit.next({ type: "error", errorText: "OpenCode server not running. Please restart the app." })
              emit.complete()
              return
            }

            const transform = createOpenCodeTransformer()

            // Subscribe to SSE events first and wait for connection
            const serverUrl = serverManager.getServerUrl()
            if (serverUrl) {
              const subscription = serverManager.subscribeToEvents(
                input.cwd,
                (event) => {
                  // Filter events for our session
                  const e = event as OpenCodeEvent
                  
                  if (e.type === "server.connected") {
                    return
                  }
                  
                  // Skip heartbeats
                  if ((e as any).type === "server.heartbeat") {
                    return
                  }

                  // Only process events for our session (if we have a session)
                  const eventSessionId = getSessionIdFromEvent(e)
                  if (eventSessionId && currentSessionId && eventSessionId !== currentSessionId) {
                    return // Not our session
                  }

                  // Transform and emit
                  for (const chunk of transform(e)) {
                    try {
                      emit.next(chunk)
                    } catch (emitErr) {
                      console.error("[OpenCode] emit.next failed:", emitErr)
                    }
                  }

                  // Check for completion - session.idle means we're done
                  if (e.type === "session.idle") {
                    activeSessions.delete(input.subChatId)
                    eventUnsubscribe?.()
                  }
                },
                (error) => {
                  emit.next({ type: "error", errorText: error.message })
                  emit.complete()
                }
              )
              eventUnsubscribe = subscription.unsubscribe
              
              // Wait for SSE connection to be established before proceeding
              await subscription.connected
            }

            // Create or resume session
            let sessionId = input.sessionId
            if (!sessionId) {
              const result = await client.session.create({
                query: { directory: input.cwd },
                body: {},
              })
              sessionId = result.data?.id
              currentSessionId = sessionId || null

              // Emit session ID immediately so the renderer can save it
              if (sessionId) {
                emit.next({
                  type: "message-metadata",
                  messageMetadata: { sessionId },
                })
              }

              // Update the stored session info
              if (sessionId) {
                activeSessions.set(input.subChatId, {
                  abort: () => abortController.abort(),
                  sessionId,
                })
              }
            }

            if (!sessionId) {
              emit.next({ type: "error", errorText: "Failed to create session" })
              emit.complete()
              return
            }

            // Build message parts
            const parts: Array<{ type: "text"; text: string } | { type: "file"; mime: string; url: string }> = [
              { type: "text", text: input.prompt },
            ]

            // Add images if provided
            if (input.images) {
              for (const img of input.images) {
                parts.push({
                  type: "file",
                  mime: img.mediaType,
                  url: `data:${img.mediaType};base64,${img.base64Data}`,
                })
              }
            }

            // Determine agent mode
            const agent = input.mode === "plan" ? "plan" : undefined

            // Send prompt (async - response comes via SSE)
            await client.session.promptAsync({
              query: { directory: input.cwd },
              path: { id: sessionId },
              body: {
                parts,
                agent,
                model: input.provider && input.model
                  ? { providerID: input.provider, modelID: input.model }
                  : undefined,
              },
            })
          } catch (error) {
            console.error("[OpenCode] Error:", error)
            emit.next({
              type: "error",
              errorText: error instanceof Error ? error.message : "Unknown error",
            })
            emit.complete()
          }
        }

        run()

        // Cleanup on unsubscribe
        return () => {
          abortController.abort()
          eventUnsubscribe?.()
          activeSessions.delete(input.subChatId)
        }
      })
    }),

  /**
   * Cancel an active session
   */
  cancel: publicProcedure
    .input(z.object({ subChatId: z.string() }))
    .mutation(async ({ input }) => {
      const session = activeSessions.get(input.subChatId)
      if (session) {
        session.abort()

        // Also abort on server side
        const client = serverManager.getClient()
        if (client && session.sessionId) {
          try {
            await client.session.abort({ path: { id: session.sessionId } })
          } catch {
            // Ignore abort errors
          }
        }

        activeSessions.delete(input.subChatId)
        return { cancelled: true }
      }
      return { cancelled: false }
    }),

  /**
   * Check if a session is active
   */
  isActive: publicProcedure
    .input(z.object({ subChatId: z.string() }))
    .query(({ input }) => {
      return activeSessions.has(input.subChatId)
    }),

  /**
   * Respond to a permission request
   */
  respondPermission: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        permissionId: z.string(),
        response: z.enum(["always", "once", "reject"]),
      })
    )
    .mutation(async ({ input }) => {
      const client = serverManager.getClient()
      if (!client) {
        throw new Error("OpenCode server not running")
      }

      await client.postSessionIdPermissionsPermissionId({
        path: { id: input.sessionId, permissionID: input.permissionId },
        body: { response: input.response },
      })

      return { ok: true }
    }),

  /**
   * Get available providers and models (only connected providers)
   */
  providers: publicProcedure.query(async () => {
    const client = serverManager.getClient()
    if (!client) {
      return { providers: [], defaults: {}, connected: [] }
    }

    try {
      const result = await client.provider.list()
      const allProviders = result.data?.all || []
      const connectedIds = result.data?.connected || []
      const defaults = result.data?.default || {}
      
      // Filter to only connected providers
      const connectedProviders = allProviders.filter(p => connectedIds.includes(p.id))
      
      return {
        providers: connectedProviders,
        defaults,
        connected: connectedIds,
      }
    } catch {
      return { providers: [], defaults: {}, connected: [] }
    }
  }),

  /**
   * Get server status
   */
  status: publicProcedure.query(() => {
    return serverManager.getState()
  }),

  /**
   * List sessions
   */
  listSessions: publicProcedure
    .input(z.object({ directory: z.string().optional() }).optional())
    .query(async () => {
      const client = serverManager.getClient()
      if (!client) {
        return []
      }

      try {
        const result = await client.session.list()
        return result.data || []
      } catch {
        return []
      }
    }),

  /**
   * Get MCP server status
   */
  getMcpConfig: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .query(async ({ input }) => {
      const client = serverManager.getClient()
      if (!client) {
        return { mcpServers: [], projectPath: input.projectPath, error: "Server not running" }
      }

      try {
        const result = await client.mcp.status()
        const mcpServers = Object.entries(result.data || {}).map(([name, status]) => ({
          name,
          status: (status as any).status || "pending",
          config: {},
        }))
        return { mcpServers, projectPath: input.projectPath }
      } catch (e) {
        return { mcpServers: [], projectPath: input.projectPath, error: String(e) }
      }
    }),

  /**
   * Respond to tool approval (legacy API compatibility)
   */
  respondToolApproval: publicProcedure
    .input(
      z.object({
        toolUseId: z.string(),
        approved: z.boolean(),
        message: z.string().optional(),
        updatedInput: z.unknown().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // This maps to OpenCode's permission system
      // toolUseId is the permission ID
      const client = serverManager.getClient()
      if (!client) {
        throw new Error("OpenCode server not running")
      }

      // TODO: Implement tool approval via OpenCode's permission system
      return { ok: true }
    }),

  /**
   * Get messages for a session
   * Used to load persisted messages from OpenCode instead of SQLite
   */
  getSessionMessages: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        directory: z.string(),
      })
    )
    .query(async ({ input }) => {
      const client = serverManager.getClient()
      if (!client) {
        return { messages: [], sessionId: input.sessionId }
      }

      try {
        const result = await client.session.messages({
          path: { id: input.sessionId },
          query: { directory: input.directory },
        })

        const messages = transformSessionMessages(result.data || [])
        return { messages, sessionId: input.sessionId }
      } catch (error) {
        console.error("[OpenCode] Failed to load session messages:", error)
        return { messages: [], sessionId: input.sessionId }
      }
    }),
})

// Helper to extract session ID from various event types
function getSessionIdFromEvent(event: OpenCodeEvent): string | null {
  switch (event.type) {
    case "message.updated":
      return event.properties.info.sessionID
    case "message.part.updated":
      return event.properties.part.sessionID
    case "message.removed":
    case "message.part.removed":
      return event.properties.sessionID
    case "session.status":
    case "session.idle":
      return event.properties.sessionID
    case "session.created":
    case "session.updated":
    case "session.deleted":
      return event.properties.info.id
    case "session.error":
      return event.properties.sessionID || null
    case "permission.updated":
      return event.properties.sessionID
    case "permission.replied":
      return event.properties.sessionID
    case "todo.updated":
      return event.properties.sessionID
    default:
      return null
  }
}

export type OpencodeRouter = typeof opencodeRouter
