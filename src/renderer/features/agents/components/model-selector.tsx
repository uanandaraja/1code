"use client"

import { useState, useMemo, useEffect, useRef } from "react"
import { useAtom } from "jotai"
import { ChevronDown } from "lucide-react"

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../components/ui/popover"
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "../../../components/ui/command"
import { CheckIcon, ClaudeCodeIcon } from "../../../components/ui/icons"
import { cn } from "../../../lib/utils"
import { trpc } from "../../../lib/trpc"
import { selectedProviderAtom, selectedModelAtom } from "../atoms"

// Model display helper
function getModelDisplayName(modelId: string): string {
  // Extract readable name from model ID
  // e.g., "claude-opus-4-5" -> "Opus", "claude-sonnet-4-5" -> "Sonnet"
  if (modelId.includes("opus")) return "Opus"
  if (modelId.includes("sonnet")) return "Sonnet"
  if (modelId.includes("haiku")) return "Haiku"
  // For other models, just capitalize
  return modelId.split("-").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(" ")
}

interface ModelSelectorProps {
  className?: string
  triggerClassName?: string
  /** Enable Cmd+/ keyboard shortcut to open the selector */
  enableKeyboardShortcut?: boolean
}

export function ModelSelector({ 
  className, 
  triggerClassName,
  enableKeyboardShortcut = false,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [selectedProvider, setSelectedProvider] = useAtom(selectedProviderAtom)
  const [selectedModel, setSelectedModel] = useAtom(selectedModelAtom)
  
  // Fetch providers from OpenCode
  const { data: providersData } = trpc.opencode.providers.useQuery()
  
  // Reset search when popover closes
  useEffect(() => {
    if (!open) {
      setSearch("")
    }
  }, [open])

  // Keyboard shortcut: Cmd+/ to open model selector
  useEffect(() => {
    if (!enableKeyboardShortcut) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "/") {
        e.preventDefault()
        e.stopPropagation()
        setOpen(true)
      }
    }

    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [enableKeyboardShortcut])

  // Flatten and filter models based on search
  const filteredProviders = useMemo(() => {
    const providers = providersData?.providers ?? []
    if (!search.trim()) return providers

    const searchLower = search.toLowerCase()
    
    return providers
      .map((provider) => {
        const modelEntries = Object.entries(provider.models || {})
        const filteredModels = modelEntries.filter(([modelId, model]) => {
          const displayName = model.name || getModelDisplayName(modelId)
          return (
            displayName.toLowerCase().includes(searchLower) ||
            modelId.toLowerCase().includes(searchLower) ||
            provider.name.toLowerCase().includes(searchLower)
          )
        })
        
        if (filteredModels.length === 0) return null
        
        return {
          ...provider,
          models: Object.fromEntries(filteredModels),
        }
      })
      .filter(Boolean) as typeof providers
  }, [providersData?.providers, search])

  // Check if there are any models at all
  const hasModels = filteredProviders.some(
    (provider) => Object.keys(provider.models || {}).length > 0
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button 
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-muted/50 outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70",
            triggerClassName
          )}
        >
          <ClaudeCodeIcon className="h-3.5 w-3.5" />
          <span>{getModelDisplayName(selectedModel)}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent 
        align="start" 
        className={cn("w-[280px] p-0", className)}
        onOpenAutoFocus={(e) => {
          // Prevent the popover from stealing focus from the input
          e.preventDefault()
        }}
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search models..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-[300px]">
            {!hasModels && (
              <CommandEmpty>
                {search ? "No models found." : "No connected providers"}
              </CommandEmpty>
            )}
            {filteredProviders.map((provider) => {
              const modelEntries = Object.entries(provider.models || {})
              if (modelEntries.length === 0) return null

              return (
                <CommandGroup key={provider.id} heading={provider.name}>
                  {modelEntries.map(([modelId, model]) => {
                    const isSelected =
                      selectedProvider === provider.id && selectedModel === modelId
                    return (
                      <CommandItem
                        key={`${provider.id}:${modelId}`}
                        value={`${provider.id}:${modelId}`}
                        onSelect={() => {
                          setSelectedProvider(provider.id)
                          setSelectedModel(modelId)
                          setOpen(false)
                        }}
                        className="gap-2 justify-between"
                      >
                        <span className="truncate">
                          {model.name || getModelDisplayName(modelId)}
                        </span>
                        {isSelected && (
                          <CheckIcon className="h-3.5 w-3.5 shrink-0" />
                        )}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
