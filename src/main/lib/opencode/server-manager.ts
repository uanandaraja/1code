import { EventEmitter } from "events"
import type { OpenCodeServerState } from "./types"

// Type-only imports (these are erased at runtime)
import type { OpencodeClient } from "@opencode-ai/sdk"

const DEFAULT_PORT = 4096
const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_PORT}`

// Dynamically imported SDK functions
let createOpencodeServer: typeof import("@opencode-ai/sdk").createOpencodeServer
let createOpencodeClient: typeof import("@opencode-ai/sdk").createOpencodeClient

async function loadSdk() {
  if (!createOpencodeServer || !createOpencodeClient) {
    const sdk = await import("@opencode-ai/sdk")
    createOpencodeServer = sdk.createOpencodeServer
    createOpencodeClient = sdk.createOpencodeClient
  }
}

/**
 * Check if an OpenCode server is already running on the default port
 */
async function checkExistingServer(): Promise<boolean> {
  try {
    const response = await fetch(`${DEFAULT_URL}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    })
    return response.ok
  } catch {
    return false
  }
}

class OpenCodeServerManager extends EventEmitter {
  private server: { url: string; close: () => void } | null = null
  private client: OpencodeClient | null = null
  private usingExternalServer = false
  private state: OpenCodeServerState = {
    status: "stopped",
    url: null,
    error: null,
    directory: null,
  }

  constructor() {
    super()
  }

  getState(): OpenCodeServerState {
    return { ...this.state }
  }

  getClient(): OpencodeClient | null {
    return this.client
  }

  getServerUrl(): string | null {
    return this.state.url
  }

  isRunning(): boolean {
    return this.state.status === "running" && this.client !== null
  }

  async start(directory?: string): Promise<void> {
    if (this.state.status === "running") {
      return
    }

    try {
      this.state = {
        status: "starting",
        url: null,
        error: null,
        directory: directory || null,
      }
      this.emit("state-change", this.state)

      // Load SDK dynamically (ESM module)
      await loadSdk()

      // Check if a server is already running on the default port
      const existingServerRunning = await checkExistingServer()
      
      if (existingServerRunning) {
        // Reuse the existing server
        console.log("[OpenCode] Found existing server, connecting to it")
        this.usingExternalServer = true
        this.server = null // We didn't start it, so we shouldn't close it
        
        // Create client pointing to existing server
        this.client = createOpencodeClient({
          baseUrl: DEFAULT_URL,
          directory,
        })
      } else {
        // Start a new server
        this.usingExternalServer = false
        this.server = await createOpencodeServer({
          hostname: "127.0.0.1",
          port: DEFAULT_PORT,
          timeout: 30000, // 30 seconds timeout
        })

        // Create client
        this.client = createOpencodeClient({
          baseUrl: this.server.url,
          directory,
        })
      }

      // Verify connection by getting project info (lightweight check)
      try {
        await this.client.project.list()
      } catch {
        // It's okay if this fails - server might not have a project yet
      }

      this.state = {
        status: "running",
        url: this.usingExternalServer ? DEFAULT_URL : this.server!.url,
        error: null,
        directory: directory || null,
      }
      this.emit("state-change", this.state)
    } catch (error) {
      console.error("[OpenCode] Failed to start server:", error)
      this.state = {
        status: "error",
        url: null,
        error: error instanceof Error ? error.message : String(error),
        directory: null,
      }
      this.emit("state-change", this.state)
      throw error
    }
  }

  async shutdown(): Promise<void> {
    // Only close the server if we started it (not if we connected to an existing one)
    if (this.server && !this.usingExternalServer) {
      this.server.close()
    }
    this.server = null
    this.usingExternalServer = false

    this.client = null
    this.state = {
      status: "stopped",
      url: null,
      error: null,
      directory: null,
    }
    this.emit("state-change", this.state)
  }

  // Subscribe to SSE events using manual fetch (more reliable in Electron)
  // Returns { unsubscribe, connected } where connected is a promise that resolves when SSE is connected
  subscribeToEvents(
    directory: string,
    onEvent: (event: unknown) => void,
    onError?: (error: Error) => void
  ): { unsubscribe: () => void; connected: Promise<void> } {
    if (!this.state.url) {
      throw new Error("Server not running")
    }

    // Build the SSE URL with directory query param
    const eventSourceUrl = `${this.state.url}/event?directory=${encodeURIComponent(directory)}`

    const abortController = new AbortController()
    let resolveConnected!: () => void
    let rejectConnected!: (err: Error) => void
    const connectedPromise = new Promise<void>((resolve, reject) => {
      resolveConnected = resolve
      rejectConnected = reject
    })
    
    ;(async () => {
      try {
        const response = await fetch(eventSourceUrl, {
          headers: { 
            "Accept": "text/event-stream",
            "Cache-Control": "no-cache",
          },
          signal: abortController.signal,
        })

        if (!response.ok) {
          throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`)
        }

        if (!response.body) {
          throw new Error("No response body for SSE")
        }

        resolveConnected()

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }

          buffer += decoder.decode(value, { stream: true })
          
          // SSE events are separated by double newlines
          const events = buffer.split("\n\n")
          // Keep the last incomplete chunk in buffer
          buffer = events.pop() || ""

          for (const eventChunk of events) {
            if (!eventChunk.trim()) continue
            
            // Parse SSE format: "data: {...}"
            const lines = eventChunk.split("\n")
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const jsonStr = line.slice(6) // Remove "data: " prefix
                try {
                  const data = JSON.parse(jsonStr)
                  onEvent(data)
                } catch {
                  // Ignore parse errors
                }
              }
            }
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return
        }
        rejectConnected(error as Error)
        onError?.(error as Error)
      }
    })()

    return {
      unsubscribe: () => {
        abortController.abort()
      },
      connected: connectedPromise,
    }
  }
}

// Singleton instance
export const serverManager = new OpenCodeServerManager()
