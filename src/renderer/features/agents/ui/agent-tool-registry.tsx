"use client"

import {
  SearchIcon,
  EyeIcon,
  IconEditFile,
  PlanningIcon,
  WriteFileIcon,
  CustomTerminalIcon,
  GlobeIcon,
  SparklesIcon,
} from "../../../components/ui/icons"
import {
  FolderSearch,
  GitBranch,
  ListTodo,
  LogOut,
  FileCode2,
  Terminal,
  XCircle,
  Server,
  Database,
  Minimize2,
} from "lucide-react"

export type ToolVariant = "simple" | "collapsible"

// Prefix symbols for different tool types (like OpenCode TUI)
export type ToolPrefix = "arrow" | "asterisk" | "nested" | "hash" | "none"

export interface ToolMeta {
  icon: React.ComponentType<{ className?: string }>
  prefix: ToolPrefix
  title: (part: any) => string
  subtitle?: (part: any) => string
  tooltipContent?: (part: any) => string
  variant: ToolVariant
}

export function getToolStatus(part: any, chatStatus?: string) {
  const basePending =
    part.state !== "output-available" && part.state !== "output-error"
  const isError =
    part.state === "output-error" ||
    (part.state === "output-available" && part.output?.success === false)
  const isSuccess = part.state === "output-available" && !isError
  // Critical: if chat stopped streaming, pending tools should show as complete
  const isPending = basePending && chatStatus === "streaming"
  // Tool was in progress but chat stopped streaming (user interrupted)
  const isInterrupted = basePending && chatStatus !== "streaming" && chatStatus !== undefined

  return { isPending, isError, isSuccess, isInterrupted }
}

// Helper to get input value - checks both camelCase and snake_case variants
// OpenCode uses camelCase (filePath), but some code expects snake_case (file_path)
function getInput(input: any, ...keys: string[]): any {
  if (!input) return undefined
  for (const key of keys) {
    if (input[key] !== undefined) return input[key]
  }
  return undefined
}

// Utility to get clean display path (remove home/absolute prefix, keep relative)
function getDisplayPath(filePath: string): string {
  if (!filePath) return ""
  
  // Remove common prefixes
  const prefixes = [
    "/project/sandbox/repo/",
    "/project/sandbox/",
    "/project/",
  ]
  for (const prefix of prefixes) {
    if (filePath.startsWith(prefix)) {
      return filePath.slice(prefix.length)
    }
  }
  
  // For absolute paths, try to find a sensible root
  if (filePath.startsWith("/")) {
    const parts = filePath.split("/")
    
    // Look for common project root indicators
    const rootIndicators = ["apps", "packages", "src", "lib", "components", "features", "main", "renderer"]
    const rootIndex = parts.findIndex((p: string) => rootIndicators.includes(p))
    if (rootIndex > 0) {
      return parts.slice(rootIndex).join("/")
    }
    
    // If path contains .21st/worktrees, show from project name onwards
    const worktreeIndex = parts.findIndex(p => p === "worktrees")
    if (worktreeIndex > 0 && parts.length > worktreeIndex + 2) {
      // Skip worktrees/{projectId}/{chatId}/ and show from there
      return parts.slice(worktreeIndex + 3).join("/") || filePath
    }
    
    // Otherwise just show last 3 parts max
    if (parts.length > 4) {
      return parts.slice(-3).join("/")
    }
  }
  
  return filePath
}

// Utility to calculate diff stats
function calculateDiffStats(oldString: string, newString: string) {
  const oldLines = oldString.split("\n")
  const newLines = newString.split("\n")
  const maxLines = Math.max(oldLines.length, newLines.length)
  let addedLines = 0
  let removedLines = 0

  for (let i = 0; i < maxLines; i++) {
    const oldLine = oldLines[i]
    const newLine = newLines[i]
    if (oldLine !== undefined && newLine !== undefined) {
      if (oldLine !== newLine) {
        removedLines++
        addedLines++
      }
    } else if (oldLine !== undefined) {
      removedLines++
    } else if (newLine !== undefined) {
      addedLines++
    }
  }
  return { addedLines, removedLines }
}

// Format parameters for display like [offset=340, limit=100]
function formatParams(params: Record<string, any>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      parts.push(`${key}=${value}`)
    }
  }
  return parts.length > 0 ? `[${parts.join(", ")}]` : ""
}

export const AgentToolRegistry: Record<string, ToolMeta> = {
  "tool-Task": {
    icon: SparklesIcon,
    prefix: "hash",
    title: (part) => {
      const description = getInput(part.input, "description") || ""
      if (description) {
        return description.length > 60 ? description.slice(0, 57) + "..." : description
      }
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      return isPending ? "Running Task" : "Task completed"
    },
    subtitle: (part) => {
      const subagentType = getInput(part.input, "subagent_type", "subagentType") || ""
      return subagentType
    },
    variant: "simple",
  },

  "tool-Grep": {
    icon: SearchIcon,
    prefix: "asterisk",
    title: (part) => {
      const pattern = getInput(part.input, "pattern") || ""
      const path = getInput(part.input, "path") || ""
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      
      // Get result count from output
      const numFiles = part.output?.numFiles || part.output?.content?.split("\n").filter(Boolean).length || 0
      const resultSuffix = !isPending && numFiles > 0 ? ` (${numFiles} matches)` : !isPending ? " (no matches)" : ""
      
      if (pattern && path) {
        const displayPath = getDisplayPath(path)
        return `Grep "${pattern}" in ${displayPath}${resultSuffix}`
      }
      if (pattern) {
        return `Grep "${pattern}"${resultSuffix}`
      }
      return isPending ? "Grep" : `Grep${resultSuffix}`
    },
    variant: "simple",
  },

  "tool-Glob": {
    icon: FolderSearch,
    prefix: "asterisk",
    title: (part) => {
      const pattern = getInput(part.input, "pattern") || ""
      const path = getInput(part.input, "path", "target_directory", "targetDirectory") || ""
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      
      // Get result count
      const numFiles = part.output?.numFiles || 0
      const resultSuffix = !isPending && numFiles > 0 ? ` (${numFiles} files)` : !isPending ? " (no files)" : ""
      
      if (pattern && path) {
        const displayPath = getDisplayPath(path)
        return `Glob ${pattern} in ${displayPath}${resultSuffix}`
      }
      if (pattern) {
        return `Glob ${pattern}${resultSuffix}`
      }
      return isPending ? "Glob" : `Glob${resultSuffix}`
    },
    variant: "simple",
  },

  "tool-Read": {
    icon: EyeIcon,
    prefix: "arrow",
    title: (part) => {
      const filePath = getInput(part.input, "filePath", "file_path") || ""
      const offset = getInput(part.input, "offset")
      const limit = getInput(part.input, "limit")
      
      if (!filePath) return "Read"
      
      const displayPath = getDisplayPath(filePath)
      const params: Record<string, any> = {}
      if (offset !== undefined) params.offset = offset
      if (limit !== undefined) params.limit = limit
      
      const paramStr = formatParams(params)
      return `Read ${displayPath}${paramStr ? " " + paramStr : ""}`
    },
    variant: "simple",
  },

  "tool-Edit": {
    icon: IconEditFile,
    prefix: "arrow",
    title: (part) => {
      const filePath = getInput(part.input, "filePath", "file_path") || ""
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      
      if (!filePath) return isPending ? "Editing" : "Edited"
      
      const displayPath = getDisplayPath(filePath)
      const oldString = getInput(part.input, "oldString", "old_string") || ""
      const newString = getInput(part.input, "newString", "new_string") || ""
      
      // Calculate diff stats if available
      if (!isPending && oldString !== newString && (oldString || newString)) {
        const { addedLines, removedLines } = calculateDiffStats(oldString, newString)
        return `Edited ${displayPath} (+${addedLines} -${removedLines})`
      }
      
      return `${isPending ? "Editing" : "Edited"} ${displayPath}`
    },
    variant: "simple",
  },

  "tool-Write": {
    icon: WriteFileIcon,
    prefix: "arrow",
    title: (part) => {
      const filePath = getInput(part.input, "filePath", "file_path") || ""
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      
      if (!filePath) return isPending ? "Writing" : "Wrote"
      
      const displayPath = getDisplayPath(filePath)
      return `${isPending ? "Writing" : "Wrote"} ${displayPath}`
    },
    variant: "simple",
  },

  "tool-Bash": {
    icon: CustomTerminalIcon,
    prefix: "arrow",
    title: (part) => {
      const command = getInput(part.input, "command") || ""
      const description = getInput(part.input, "description") || ""
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      
      // Show description if available, otherwise show command
      if (description) {
        return `Bash ${description}`
      }
      if (command) {
        // Truncate long commands
        const displayCmd = command.length > 80 ? command.slice(0, 77) + "..." : command
        return `Bash ${displayCmd}`
      }
      return isPending ? "Bash" : "Ran command"
    },
    variant: "simple",
  },

  "tool-WebFetch": {
    icon: GlobeIcon,
    prefix: "arrow",
    title: (part) => {
      const url = getInput(part.input, "url") || ""
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      
      if (url) {
        try {
          const hostname = new URL(url).hostname.replace("www.", "")
          return `${isPending ? "Fetching" : "Fetched"} ${hostname}`
        } catch {
          const truncated = url.length > 50 ? url.slice(0, 47) + "..." : url
          return `${isPending ? "Fetching" : "Fetched"} ${truncated}`
        }
      }
      return isPending ? "Fetching" : "Fetched"
    },
    variant: "simple",
  },

  "tool-WebSearch": {
    icon: SearchIcon,
    prefix: "asterisk",
    title: (part) => {
      const query = getInput(part.input, "query") || ""
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      
      if (query) {
        const truncated = query.length > 50 ? query.slice(0, 47) + "..." : query
        return `${isPending ? "Searching" : "Searched"} "${truncated}"`
      }
      return isPending ? "Searching web" : "Searched web"
    },
    variant: "collapsible",
  },

  // Cloning indicator - shown while sandbox is being created
  "tool-cloning": {
    icon: GitBranch,
    prefix: "arrow",
    title: () => "Cloning repo",
    variant: "simple",
  },

  // Planning indicator - shown when streaming starts but no content yet
  "tool-planning": {
    icon: PlanningIcon,
    prefix: "none",
    title: () => {
      const messages = [
        "Crafting...",
        "Whirring...",
        "Imagining...",
        "Cooking...",
        "Sussing...",
        "Unravelling...",
        "Creating...",
        "Spinning...",
        "Computing...",
        "Synthesizing...",
        "Manifesting...",
      ]
      return messages[Math.floor(Math.random() * messages.length)]
    },
    variant: "simple",
  },

  // Planning tools
  "tool-TodoWrite": {
    icon: ListTodo,
    prefix: "arrow",
    title: (part) => {
      const todos = getInput(part.input, "todos") || []
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      const count = todos.length
      if (isPending) {
        return count > 0 ? `Updating ${count} todos` : "Updating todos"
      }
      return count > 0 ? `Updated ${count} todos` : "Updated todos"
    },
    variant: "simple",
  },

  "tool-TodoRead": {
    icon: ListTodo,
    prefix: "arrow",
    title: () => "Read todos",
    variant: "simple",
  },

  "tool-PlanWrite": {
    icon: PlanningIcon,
    prefix: "arrow",
    title: (part) => {
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      const action = getInput(part.input, "action") || "create"
      const status = part.input?.plan?.status
      if (isPending) {
        if (action === "create") return "Creating plan"
        if (action === "approve") return "Approving plan"
        if (action === "complete") return "Completing plan"
        return "Updating plan"
      }
      if (status === "awaiting_approval") return "Plan ready for review"
      if (status === "approved") return "Plan approved"
      if (status === "completed") return "Plan completed"
      return action === "create" ? "Created plan" : "Updated plan"
    },
    subtitle: (part) => {
      const plan = part.input?.plan
      if (!plan) return ""
      const steps = plan.steps || []
      const completed = steps.filter((s: any) => s.status === "completed").length
      if (plan.title) {
        return steps.length > 0 
          ? `${plan.title} (${completed}/${steps.length})`
          : plan.title
      }
      return steps.length > 0 
        ? `${completed}/${steps.length} steps`
        : ""
    },
    variant: "simple",
  },

  "tool-ExitPlanMode": {
    icon: LogOut,
    prefix: "arrow",
    title: (part) => {
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      return isPending ? "Finishing plan" : "Plan complete"
    },
    variant: "simple",
  },

  // Notebook tools
  "tool-NotebookEdit": {
    icon: FileCode2,
    prefix: "arrow",
    title: (part) => {
      const filePath = getInput(part.input, "filePath", "file_path") || ""
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      if (filePath) {
        const displayPath = getDisplayPath(filePath)
        return `${isPending ? "Editing" : "Edited"} ${displayPath}`
      }
      return isPending ? "Editing notebook" : "Edited notebook"
    },
    variant: "simple",
  },

  // Shell management tools
  "tool-BashOutput": {
    icon: Terminal,
    prefix: "arrow",
    title: (part) => {
      const pid = getInput(part.input, "pid")
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      if (pid) {
        return `${isPending ? "Getting" : "Got"} output (PID: ${pid})`
      }
      return isPending ? "Getting output" : "Got output"
    },
    variant: "simple",
  },

  "tool-KillShell": {
    icon: XCircle,
    prefix: "arrow",
    title: (part) => {
      const pid = getInput(part.input, "pid")
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      if (pid) {
        return `${isPending ? "Stopping" : "Stopped"} shell (PID: ${pid})`
      }
      return isPending ? "Stopping shell" : "Stopped shell"
    },
    variant: "simple",
  },

  // MCP tools
  "tool-ListMcpResources": {
    icon: Server,
    prefix: "arrow",
    title: (part) => {
      const server = getInput(part.input, "server") || ""
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      if (server) {
        return `${isPending ? "Listing" : "Listed"} resources from ${server}`
      }
      return isPending ? "Listing resources" : "Listed resources"
    },
    variant: "simple",
  },

  "tool-ReadMcpResource": {
    icon: Database,
    prefix: "arrow",
    title: (part) => {
      const uri = getInput(part.input, "uri") || ""
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      if (uri) {
        const truncated = uri.length > 40 ? "..." + uri.slice(-37) : uri
        return `${isPending ? "Reading" : "Read"} ${truncated}`
      }
      return isPending ? "Reading resource" : "Read resource"
    },
    variant: "simple",
  },

  // Type lookup tools
  "tool-LookupType": {
    icon: SearchIcon,
    prefix: "asterisk",
    title: (part) => {
      const name = getInput(part.input, "name") || ""
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      if (name) {
        return `${isPending ? "Looking up" : "Looked up"} type "${name}"`
      }
      return isPending ? "Looking up type" : "Looked up type"
    },
    variant: "simple",
  },

  "tool-ListTypes": {
    icon: SearchIcon,
    prefix: "asterisk",
    title: (part) => {
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      return isPending ? "Listing types" : "Listed types"
    },
    variant: "simple",
  },

  // System tools
  "system-Compact": {
    icon: Minimize2,
    prefix: "arrow",
    title: (part) => {
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      return isPending ? "Compacting..." : "Compacted"
    },
    variant: "simple",
  },

  // Extended Thinking
  "tool-Thinking": {
    icon: SparklesIcon,
    prefix: "none",
    title: (part) => {
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      return isPending ? "Thinking..." : "Thought"
    },
    subtitle: (part) => {
      const text = getInput(part.input, "text") || ""
      // Show first 50 chars as preview
      return text.length > 50 ? text.slice(0, 47) + "..." : text
    },
    variant: "collapsible",
  },

  // Skill tool
  "tool-Skill": {
    icon: SparklesIcon,
    prefix: "arrow",
    title: (part) => {
      const name = getInput(part.input, "name") || ""
      const isPending = part.state !== "output-available" && part.state !== "output-error"
      if (name) {
        return `${isPending ? "Loading" : "Loaded"} skill "${name}"`
      }
      return isPending ? "Loading skill" : "Loaded skill"
    },
    variant: "simple",
  },
}

// Helper to get prefix symbol for rendering
export function getToolPrefixSymbol(prefix: ToolPrefix): string {
  switch (prefix) {
    case "arrow": return "→"
    case "asterisk": return "*"
    case "nested": return "└"
    case "hash": return "#"
    case "none": return ""
  }
}
