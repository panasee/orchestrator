# Orchestrator

OpenClaw prompt-router plugin.

What it does:

- Applies only to selected agents.
- Always injects core prompt files and common prompt files on every turn.
- Classifies each turn into one or more routes when the current user request is available.
- Injects one or more route-specific prompts before the main model runs.
- Optionally uses a separate `classifierModel` for route classification.
- Keeps built-in routes as defaults, but route definitions are now config-driven.

What it does not do:

- No agent generation.
- No subagent orchestration.
- No execution-model switching.
- No context-engine behavior.

Example config:

```json
{
  "plugins": {
    "load": {
      "paths": ["$REPO_PATH"]
    },
    "entries": {
      "orchestrator": {
        "enabled": true,
        "hooks": {
          "allowPromptInjection": true
        },
        "config": {
          "corePromptFiles": ["$OPENCLAW_HOME/policies/baseline.md"],
          "commonPromptFiles": ["$OPENCLAW_HOME/policies/scenes/dialogue.md"],
          "classifierModel": "openai/gpt-5-nano",
          "defaultRoute": "general",
          "llmTimeoutMs": 8000,
          "maxRoutes": 3
        }
      }
    }
  }
}
```

If the plugin cannot read the current user request, it falls back to injecting only `corePromptFiles` and `commonPromptFiles`.

## Add a new route

1. Create a prompt file.
2. Add the route to `plugins.entries.orchestrator.config.routes`.
3. Optionally point `defaultRoute` at it.

Example:

```json
{
  "plugins": {
    "entries": {
      "orchestrator": {
        "config": {
          "routes": {
            "visual": {
              "description": "UI, styling, layout, motion, and visual quality work.",
              "promptFile": "./src/prompts/visual.md",
              "keywords": ["ui", "design", "layout", "css", "界面", "样式", "视觉"]
            }
          }
        }
      }
    }
  }
}
```
