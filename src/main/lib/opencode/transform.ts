import type {
  UIMessageChunk,
  MessageMetadata,
  MCPServer,
  Part,
  TextPart,
  ToolPart,
  ReasoningPart,
  FilePart,
  StepStartPart,
  StepFinishPart,
  Message,
  AssistantMessage,
  Permission,
  SessionStatus,
  OpenCodeEvent,
} from "./types"

/**
 * Transform OpenCode SSE events to UIMessageChunk format
 * This allows us to reuse the existing UI components
 */
export function createOpenCodeTransformer() {
  let started = false
  let startTime: number | null = null

  // Track text parts for streaming
  const textPartStates = new Map<string, { started: boolean; text: string }>()
  
  // Track reasoning parts that have been started (need tool-input-start before tool-input-delta)
  const reasoningPartStarted = new Set<string>()
  
  // Track the current assistant message ID - we only want to process parts from assistant messages
  // User message parts also come through message.part.updated but should be ignored
  let currentAssistantMessageId: string | null = null

  // Generate unique IDs
  const genId = () => `oc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

  return function* transform(event: OpenCodeEvent): Generator<UIMessageChunk> {
    // Emit start once
    if (!started) {
      started = true
      startTime = Date.now()
      yield { type: "start" }
      yield { type: "start-step" }
    }

    switch (event.type) {
      case "server.connected":
        // Server connected, no action needed
        break

      case "message.updated": {
        const message = event.properties.info
        if (message.role === "assistant") {
          const assistantMsg = message as AssistantMessage
          // Track this as the current assistant message
          currentAssistantMessageId = assistantMsg.id
          
          // Handle message completion
          if (assistantMsg.time.completed) {
            const metadata: MessageMetadata = {
              sessionId: assistantMsg.sessionID,
              inputTokens: assistantMsg.tokens.input,
              outputTokens: assistantMsg.tokens.output,
              totalTokens: assistantMsg.tokens.input + assistantMsg.tokens.output,
              totalCostUsd: assistantMsg.cost,
              durationMs: startTime ? Date.now() - startTime : undefined,
            }
            yield { type: "message-metadata", messageMetadata: metadata }
          }
          
          // Handle errors
          if (assistantMsg.error) {
            const errorMessage = getErrorMessage(assistantMsg.error)
            if (assistantMsg.error.name === "ProviderAuthError") {
              yield { type: "auth-error", errorText: errorMessage }
            } else {
              yield { type: "error", errorText: errorMessage }
            }
          }
        }
        break
      }

      case "message.part.updated": {
        const { part, delta } = event.properties
        const partMessageId = (part as any).messageID
        
        // Skip parts that don't belong to the current assistant message
        // This filters out user message parts that OpenCode also sends
        if (partMessageId && currentAssistantMessageId && partMessageId !== currentAssistantMessageId) {
          // This part belongs to a different message (likely user message), skip it
          break
        }
        
        yield* transformPart(part, delta, textPartStates, reasoningPartStarted, genId)
        break
      }

      case "message.removed":
      case "message.part.removed":
        // Could handle message/part removal if needed
        break

      case "session.status": {
        const { sessionID, status } = event.properties
        yield* handleSessionStatus(sessionID, status)
        break
      }

      case "session.idle": {
        // Session finished
        const metadata: MessageMetadata = {
          sessionId: event.properties.sessionID,
          durationMs: startTime ? Date.now() - startTime : undefined,
        }
        yield { type: "finish-step" }
        yield { type: "finish", messageMetadata: metadata }
        break
      }

      case "session.error": {
        const { error } = event.properties
        if (error) {
          yield { type: "error", errorText: getErrorMessage(error) }
        }
        break
      }

      case "permission.updated": {
        const permission = event.properties
        yield* handlePermission(permission)
        break
      }

      case "todo.updated": {
        // We could emit todo updates as a special chunk type
        // For now, we don't have a UI for this
        break
      }

      case "session.updated": {
        // Emit session title when OpenCode auto-generates it
        const session = event.properties.info
        if (session.title && !session.title.startsWith("New session - ")) {
          yield { type: "session-title", title: session.title }
        }
        break
      }

      case "session.created":
      case "session.deleted":
        // No action needed for these events
        break

      default:
        // Unknown event type, ignore
        break
    }
  }
}

function* transformPart(
  part: Part,
  delta: string | undefined,
  textPartStates: Map<string, { started: boolean; text: string }>,
  reasoningPartStarted: Set<string>,
  genId: () => string
): Generator<UIMessageChunk> {
  switch (part.type) {
    case "text": {
      const textPart = part as TextPart
      const state = textPartStates.get(textPart.id) || { started: false, text: "" }
      
      if (!state.started) {
        // Start text block
        yield { type: "text-start", id: textPart.id }
        state.started = true
        textPartStates.set(textPart.id, state)
      }

      if (delta) {
        // Streaming delta
        yield { type: "text-delta", id: textPart.id, delta }
        state.text += delta
        textPartStates.set(textPart.id, state)
      } else if (textPart.text && textPart.text !== state.text) {
        // Full text update (non-streaming case)
        const newDelta = textPart.text.slice(state.text.length)
        if (newDelta) {
          yield { type: "text-delta", id: textPart.id, delta: newDelta }
          state.text = textPart.text
          textPartStates.set(textPart.id, state)
        }
      }

      // Check if text is complete
      if (textPart.time?.end) {
        yield { type: "text-end", id: textPart.id }
      }
      break
    }

    case "reasoning": {
      const reasoningPart = part as ReasoningPart
      // Map reasoning to our "Thinking" tool format
      const toolCallId = `thinking-${reasoningPart.id}`
      
      // Must emit tool-input-start before any tool-input-delta
      // The ai SDK requires this to initialize the partialToolCalls entry
      if (!reasoningPartStarted.has(toolCallId)) {
        reasoningPartStarted.add(toolCallId)
        yield {
          type: "tool-input-start",
          toolCallId,
          toolName: "Thinking",
        }
      }
      
      if (delta) {
        // Streaming reasoning
        yield {
          type: "tool-input-delta",
          toolCallId,
          inputTextDelta: delta,
        }
      } else {
        // Complete reasoning block
        yield {
          type: "tool-input-available",
          toolCallId,
          toolName: "Thinking",
          input: { text: reasoningPart.text },
        }
        yield {
          type: "tool-output-available",
          toolCallId,
          output: { completed: true },
        }
      }
      break
    }

    case "tool": {
      const toolPart = part as ToolPart
      const toolCallId = toolPart.callID || toolPart.id
      const toolName = mapToolName(toolPart.tool)

      switch (toolPart.state.status) {
        case "pending":
          // Tool starting, input streaming
          yield {
            type: "tool-input-start",
            toolCallId,
            toolName,
          }
          break

        case "running":
          // Tool input available
          yield {
            type: "tool-input-available",
            toolCallId,
            toolName,
            input: toolPart.state.input,
          }
          break

        case "completed":
          // Tool completed
          yield {
            type: "tool-input-available",
            toolCallId,
            toolName,
            input: toolPart.state.input,
          }
          yield {
            type: "tool-output-available",
            toolCallId,
            output: parseToolOutput(toolPart.state.output, toolPart.tool),
          }
          break

        case "error":
          yield {
            type: "tool-input-available",
            toolCallId,
            toolName,
            input: toolPart.state.input,
          }
          yield {
            type: "tool-output-error",
            toolCallId,
            errorText: toolPart.state.error,
          }
          break
      }
      break
    }

    case "step-start": {
      yield { type: "start-step" }
      break
    }

    case "step-finish": {
      const stepPart = part as StepFinishPart
      yield { type: "finish-step" }
      break
    }

    // Subtask, file, snapshot, patch, agent, retry, compaction parts
    // can be handled as needed
    default:
      // Unhandled part type, ignore
      break
  }
}

function* handleSessionStatus(
  sessionID: string,
  status: SessionStatus
): Generator<UIMessageChunk> {
  switch (status.type) {
    case "idle":
      // Session is idle, will be handled by session.idle event
      break
    case "busy":
      // Session is busy processing
      break
    case "retry":
      // Retrying with attempt number
      break
  }
}

function* handlePermission(permission: Permission): Generator<UIMessageChunk> {
  // Map OpenCode permission to ask-user-question format
  yield {
    type: "ask-user-question",
    toolUseId: permission.id,
    questions: [
      {
        question: permission.title,
        header: "Permission",
        options: [
          { label: "Allow", description: "Allow this action" },
          { label: "Deny", description: "Deny this action" },
          { label: "Always Allow", description: "Remember this choice" },
        ],
        multiSelect: false,
      },
    ],
  }
}

// Map OpenCode tool names to our UI's expected names
function mapToolName(tool: string): string {
  const mapping: Record<string, string> = {
    bash: "Bash",
    read: "Read",
    write: "Write",
    edit: "Edit",
    glob: "Glob",
    grep: "Grep",
    webfetch: "WebFetch",
    websearch: "WebSearch",
    task: "Task",
    question: "AskUserQuestion",
    todoread: "TodoRead",
    todowrite: "TodoWrite",
    lookup_type: "LookupType",
    list_types: "ListTypes",
    skill: "Skill",
  }
  return mapping[tool.toLowerCase()] || tool
}

// Parse tool output from string to structured format
function parseToolOutput(output: string, tool: string): unknown {
  try {
    return JSON.parse(output)
  } catch {
    // Return as-is if not JSON
    return { content: output }
  }
}

// Extract error message from OpenCode error types
function getErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error)
  }
  
  const e = error as { name?: string; data?: { message?: string } }
  return e.data?.message || e.name || "Unknown error"
}

/**
 * UI Message format expected by the renderer
 */
export interface UIMessage {
  id: string
  role: "user" | "assistant"
  parts: UIMessagePart[]
  metadata?: {
    sessionId?: string
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cost?: number
  }
}

export type UIMessagePart =
  | { type: "text"; text: string }
  | { type: "data-image"; data: { url: string; mediaType: string; filename?: string } }
  | { type: `tool-${string}`; toolCallId: string; toolName: string; state: string; input?: unknown; output?: unknown }
  | { type: "reasoning"; id: string; text: string }

/**
 * Transform OpenCode session messages to UI message format
 * Used when loading persisted messages from OpenCode sessions
 */
export function transformSessionMessages(
  messages: Array<{ info: Message; parts: Part[] }>
): UIMessage[] {
  const result: UIMessage[] = []

  for (const { info, parts } of messages) {
    const uiMessage: UIMessage = {
      id: info.id,
      role: info.role,
      parts: [],
    }

    // Add metadata for assistant messages
    if (info.role === "assistant") {
      const assistantInfo = info as AssistantMessage
      uiMessage.metadata = {
        sessionId: assistantInfo.sessionID,
        inputTokens: assistantInfo.tokens?.input,
        outputTokens: assistantInfo.tokens?.output,
        totalTokens: (assistantInfo.tokens?.input || 0) + (assistantInfo.tokens?.output || 0),
        cost: assistantInfo.cost,
      }
    }

    // Transform parts
    for (const part of parts) {
      const uiPart = transformPartToUIPart(part)
      if (uiPart) {
        uiMessage.parts.push(uiPart)
      }
    }

    // Only add messages that have parts
    if (uiMessage.parts.length > 0) {
      result.push(uiMessage)
    }
  }

  return result
}

/**
 * Transform a single OpenCode part to UI part format
 */
function transformPartToUIPart(part: Part): UIMessagePart | null {
  switch (part.type) {
    case "text": {
      const textPart = part as TextPart
      if (!textPart.text) return null
      return { type: "text", text: textPart.text }
    }

    case "reasoning": {
      const reasoningPart = part as ReasoningPart
      if (!reasoningPart.text) return null
      return { type: "reasoning", id: reasoningPart.id, text: reasoningPart.text }
    }

    case "file": {
      const filePart = part as FilePart
      // Only handle image files for now
      if (filePart.mime?.startsWith("image/") && filePart.url) {
        return {
          type: "data-image",
          data: {
            url: filePart.url,
            mediaType: filePart.mime,
            filename: filePart.filename,
          },
        }
      }
      return null
    }

    case "tool": {
      const toolPart = part as ToolPart
      const toolName = mapToolName(toolPart.tool)
      const toolCallId = toolPart.callID || toolPart.id

      // Map OpenCode tool state to UI state
      let state: string
      let output: unknown = undefined

      switch (toolPart.state.status) {
        case "pending":
          state = "call"
          break
        case "running":
          state = "call"
          break
        case "completed":
          state = "output-available"
          output = parseToolOutput(toolPart.state.output, toolPart.tool)
          break
        case "error":
          state = "output-error"
          output = { error: toolPart.state.error }
          break
        default:
          state = "call"
      }

      return {
        type: `tool-${toolName}`,
        toolCallId,
        toolName,
        state,
        input: toolPart.state.input,
        output,
      }
    }

    // Skip step markers and other parts that don't need to be persisted
    case "step-start":
    case "step-finish":
    case "snapshot":
    case "patch":
    case "agent":
    case "retry":
    case "compaction":
    case "subtask":
      return null

    default:
      return null
  }
}
