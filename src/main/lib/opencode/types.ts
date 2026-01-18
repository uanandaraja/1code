// Type-only imports from OpenCode SDK
// Using `import type` ensures these are erased at runtime and don't cause CJS/ESM issues
import type {
  Session,
  Message,
  UserMessage,
  AssistantMessage,
  Part,
  TextPart,
  ToolPart,
  ReasoningPart,
  FilePart,
  StepStartPart,
  StepFinishPart,
  ToolState,
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
  Permission,
  SessionStatus,
  Todo,
  FileDiff,
  EventMessageUpdated,
  EventMessagePartUpdated,
  EventMessageRemoved,
  EventMessagePartRemoved,
  EventSessionStatus,
  EventSessionCreated,
  EventSessionUpdated,
  EventSessionDeleted,
  EventSessionError,
  EventSessionIdle,
  EventPermissionUpdated,
  EventPermissionReplied,
  EventTodoUpdated,
} from "@opencode-ai/sdk"

// Re-export types for convenience
export type {
  Session,
  Message,
  UserMessage,
  AssistantMessage,
  Part,
  TextPart,
  ToolPart,
  ReasoningPart,
  FilePart,
  StepStartPart,
  StepFinishPart,
  ToolState,
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
  Permission,
  SessionStatus,
  Todo,
  FileDiff,
  EventMessageUpdated,
  EventMessagePartUpdated,
  EventMessageRemoved,
  EventMessagePartRemoved,
  EventSessionStatus,
  EventSessionCreated,
  EventSessionUpdated,
  EventSessionDeleted,
  EventSessionError,
  EventSessionIdle,
  EventPermissionUpdated,
  EventPermissionReplied,
  EventTodoUpdated,
}

// OpenCode event union type
export type OpenCodeEvent =
  | { type: "server.connected"; properties: Record<string, unknown> }
  | { type: "message.updated"; properties: { info: import("@opencode-ai/sdk").Message } }
  | { type: "message.removed"; properties: { sessionID: string; messageID: string } }
  | { type: "message.part.updated"; properties: { part: import("@opencode-ai/sdk").Part; delta?: string } }
  | { type: "message.part.removed"; properties: { sessionID: string; messageID: string; partID: string } }
  | { type: "session.status"; properties: { sessionID: string; status: import("@opencode-ai/sdk").SessionStatus } }
  | { type: "session.created"; properties: { info: import("@opencode-ai/sdk").Session } }
  | { type: "session.updated"; properties: { info: import("@opencode-ai/sdk").Session } }
  | { type: "session.deleted"; properties: { info: import("@opencode-ai/sdk").Session } }
  | { type: "session.idle"; properties: { sessionID: string } }
  | { type: "session.error"; properties: { sessionID?: string; error?: unknown } }
  | { type: "permission.updated"; properties: import("@opencode-ai/sdk").Permission }
  | { type: "permission.replied"; properties: { sessionID: string; permissionID: string; response: string } }
  | { type: "todo.updated"; properties: { sessionID: string; todos: import("@opencode-ai/sdk").Todo[] } }
  | { type: "file.edited"; properties: { file: string } }

// Provider info
export interface ProviderInfo {
  id: string
  name: string
  models: ModelInfo[]
}

export interface ModelInfo {
  id: string
  name: string
  contextWindow?: number
}

// Server state
export interface OpenCodeServerState {
  status: "stopped" | "starting" | "running" | "error"
  url: string | null
  error: string | null
  directory: string | null
}

// ============================================
// UI Message Chunk Types (for streaming to renderer)
// ============================================

export type UIMessageChunk =
  // Message lifecycle
  | { type: "start"; messageId?: string }
  | { type: "finish"; messageMetadata?: MessageMetadata }
  | { type: "start-step" }
  | { type: "finish-step" }
  // Text streaming
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  // Reasoning (Extended Thinking)
  | { type: "reasoning"; id: string; text: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  // Tool calls
  | { type: "tool-input-start"; toolCallId: string; toolName: string }
  | { type: "tool-input-delta"; toolCallId: string; inputTextDelta: string }
  | {
      type: "tool-input-available"
      toolCallId: string
      toolName: string
      input: unknown
    }
  | { type: "tool-output-available"; toolCallId: string; output: unknown }
  | { type: "tool-output-error"; toolCallId: string; errorText: string }
  // Error & metadata
  | { type: "error"; errorText: string }
  | { type: "auth-error"; errorText: string }
  | {
      type: "ask-user-question"
      toolUseId: string
      questions: Array<{
        question: string
        header: string
        options: Array<{ label: string; description: string }>
        multiSelect: boolean
      }>
    }
  | { type: "ask-user-question-timeout"; toolUseId: string }
  | { type: "message-metadata"; messageMetadata: MessageMetadata }
  // System tools (rendered like regular tools)
  | {
      type: "system-Compact"
      toolCallId: string
      state: "input-streaming" | "output-available"
    }
  // Session initialization (MCP servers, plugins, tools)
  | {
      type: "session-init"
      tools: string[]
      mcpServers: MCPServer[]
      plugins: { name: string; path: string }[]
      skills: string[]
    }
  // Session title (auto-generated by OpenCode)
  | { type: "session-title"; title: string }

export type MCPServerStatus = "connected" | "failed" | "pending" | "needs-auth"

export type MCPServer = {
  name: string
  status: MCPServerStatus
  serverInfo?: {
    name: string
    version: string
  }
  error?: string
}

export type MessageMetadata = {
  sessionId?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  totalCostUsd?: number
  durationMs?: number
  resultSubtype?: string
  finalTextId?: string
}
