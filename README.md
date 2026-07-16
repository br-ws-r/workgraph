# pi-cognee

Cognee AI memory for [Pi](https://github.com/earendil-works/pi-coding-agent) — your coding agent with persistent, queryable knowledge graph memory.

Two backends, one interface:

| Mode | How | Best for |
|------|-----|----------|
| **SDK** (default) | In-process via `@cognee/cognee-ts` | Zero-infrastructure, works out of the box |
| **MCP** | Remote Cognee MCP server | Shared memory across agents, self-hosted |

## Install

```bash
pi install npm:@kerryhatcher/pi-cognee
```

## Quick Start (SDK mode)

SDK mode works immediately — no server needed. Just set your LLM API key:

```bash
# In pi:
/cognee-config llmApiKey sk-...
/cognee-config llmModel gpt-4o-mini
```

Then start using memory:

```
> Remember this: the project uses Postgres with Prisma ORM
> What database does this project use?
```

## MCP Mode

If you run a [Cognee MCP server](https://github.com/topoteretes/cognee), switch to MCP mode:

```bash
/cognee-mode mcp
/cognee-config mcpUrl http://localhost:8001/mcp
```

## Commands

| Command | Description |
|---------|-------------|
| `/cognee-mode [sdk\|mcp]` | Switch backend mode |
| `/cognee-config` | Show all config |
| `/cognee-config <key>` | Show one config value |
| `/cognee-config <key> <value>` | Set a config value |

## Tools

All tools work identically in both modes:

| Tool | Description |
|------|-------------|
| `cognee_health` | Check connectivity |
| `cognee_remember` | Store text in memory |
| `cognee_recall` | Search memory |
| `cognee_forget` | Delete datasets or all memory |
| `cognee_datasets` | List datasets |
| `cognee_dataset_data` | List items in a dataset |
| `cognee_create_dataset` | Create a new dataset |
| `cognee_client_info` | Show client identity and mode |
| `cognee_cognify_file` | Ingest a file (base64) |

## Config Keys

| Key | Default | Description |
|-----|---------|-------------|
| `mode` | `sdk` | Backend mode: `sdk` or `mcp` |
| `mcpUrl` | `http://localhost:8001/mcp` | MCP server URL |
| `llmModel` | — | LLM model (SDK mode) |
| `llmApiKey` | — | LLM API key (SDK mode) |
| `embeddingProvider` | — | Embedding provider (SDK mode) |
| `embeddingModel` | — | Embedding model (SDK mode) |
| `vectorDbProvider` | — | Vector DB provider (SDK mode) |
| `graphDbProvider` | — | Graph DB provider (SDK mode) |

## License

MIT
