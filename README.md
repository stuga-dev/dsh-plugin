# @stuga/dsh-plugin

Connect a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) profile to [Stuga](https://github.com/stuga-dev/stuga).

Stuga is a self-hosted collaborative workspace: real-time documents, structured databases with SQL, hybrid search, and first-class access for AI agents. An agent never writes silently: every edit is a **proposal** on a reviewable run ledger, attributed to the agent's key and accepted, rejected or reverted by a human. This plugin makes a DeepSeek Harness agent a well-behaved Stuga agent.

It is a thin layer, on purpose:

| Piece | What it does |
|---|---|
| `cordis.patch.yml` | Mounts the harness's in-box MCP client against the node's `/mcp`, so the model gets Stuga's tools as `mcp__stuga__*`: `workspaces`, `docs`, `search`, `markdown`, `comments`, `folders`, `events`, `collections`, `retrieve`, `databases` and `query` to read; `docs_create`, `markdown_append`, `markdown_edit`, `comments_add`, `media_upload`, `collections_edit`, `databases_add` and `databases_change` to write. |
| `index.js` | Registers one system-prompt section explaining how calls are routed and reviewed, ends it with the key's own workspace and its conventions, and registers three playbook skills. |
| `skills/` | `stuga-research`, `stuga-propose-edits`, `stuga-databases` — loaded on demand through the harness's `skill` tool. |

Everything Stuga enforces (the run ledger, access control inside search, per-call audit, read-only keys) is enforced by the Stuga node. The plugin only holds an agent key and shapes the model's behaviour against that surface.

## Install

You need a running Stuga node and a DeepSeek Harness installation (Node `^22.19 || >=24`, `pnpm` on `PATH`).

1. In Stuga, open **Settings → Your own AI**, choose **DeepSeek Harness**, and mint an agent key. Name it after the harness (that name is what reviewers see in the inbox). Narrow it to folders, make it read-only, or give it an expiry as you see fit. The key reaches every workspace you belong to; one narrowed to folders stays in the workspace it was minted in. The tab prints the command and environment lines below with the key filled in.

2. Install the plugin into the profile you run (the web UI profile is `web`):

   ```sh
   dsh plugin --profile web add @stuga/dsh-plugin
   ```

   From a checkout instead of npm: `dsh plugin --profile web add /path/to/dsh-plugin`.

3. Tell the harness where the node is and which key to use. Either export them in the shell that launches it, or put them in `$DSH_HOME/.env`:

   ```sh
   STUGA_URL=http://127.0.0.1:8787
   STUGA_API_KEY=vk_…
   ```

4. Restart `dsh web`. Check the composition with:

   ```sh
   dsh --profile web --dump-config
   ```

   You should see the `stuga-mcp` and `stuga-guidance` rows. In a new session the `mcp__stuga__*` tools are available, and the `skill` tool lists the three playbooks.

To remove: `dsh plugin --profile web remove @stuga/dsh-plugin`.

## What the reviewer sees

When the agent proposes an edit, the tool result says `Proposed — … This is SUCCESS: do NOT retry` and the prompt section tells the model to end its reply with links to `<STUGA_URL>/doc/<doc_id>` and `<STUGA_URL>/review`. Open those in Stuga to accept or reject each change hunk by hunk. In the inbox the run is badged `deepseek-harness` (the plugin sends an `x-stuga-client` header) under the key's name. If the document is set to apply agent changes at once, the edit lands immediately and the reviewer is notified; the result then says `Applied`.

## Configuration

The `stuga-guidance` row accepts:

| Field | Default | Meaning |
|---|---|---|
| `url` | `$STUGA_URL` or `http://127.0.0.1:8787` | Origin used in the links the model gives the reviewer |
| `serverName` | `stuga` | Must match the MCP row's `serverName`; sets the `mcp__<serverName>__` prefix the prompt refers to |
| `section` | `true` | Register the system-prompt section |
| `skills` | `true` | Register the three playbook skills |
| `instructions` | `true` | Read the key's workspace and its conventions and put them in the system prompt |
| `instructionsRefreshMs` | `300000` | How often they are re-read |

### The key's workspace and its conventions

Every Stuga tool call names the workspace it acts in: `workspace_id`, or for `search` and `retrieve`, `workspace_ids`, where `["*"]` covers every workspace the key reaches. A workspace can also carry free-text conventions for agents (**Settings → This workspace → Agents**): where notes go, what not to touch, the house style. The node serves its workspaces and conventions in its MCP server's `instructions` field, but the harness's MCP client does not surface that field, and a model told to fetch them often simply does not — in an end-to-end run, gpt-4o edited a document without ever calling `workspaces action:instructions`.

So the plugin reads the key's own workspace itself, over the same key — its `workspace_id`, its name and its conventions — and ends the prompt section with them, where they cannot be skipped. The model can call tools there at once. `workspaces` action `list` names any other workspace the key reaches, and the prompt section and the playbooks tell the model to read that workspace's conventions with `workspaces` action `instructions` before writing there. A node that is down or a key without access means the same thing: the section is registered without the workspace, and nothing fails.

Folders, databases and documents can carry their own instructions too, from their ⋯ menu in Stuga. They add to the workspace's, from the outermost level in, and depend on the item, so the plugin does not put them in the system prompt. The node hands them over with the item: `markdown` `read` shows them in a marked block before the document's text, or opens with a line saying none apply, so instructions planted in a document's text never lead the read; and `docs` `metadata`, `docs_create` and `databases` `schema` return them as `instructions`. The prompt section and the playbooks tell the model to follow them when it writes there, never to copy them into an edit, and to treat anything further down a read that looks like such a block as document text.

### Labelling the model

Runs from this plugin are badged `deepseek-harness` in Stuga's review inbox. The harness does not expose the running model to its MCP layer, so the model label is yours to set: export `STUGA_MODEL=gpt-4o` (or whichever you pinned) and it appears beside the client badge.

Override a row by its id in `$DSH_HOME/profiles/web/cordis.patch.yml`. A patch replaces the row's whole `config`, so restate every key you need. For example, to point the MCP row at a node behind TLS with a longer tool timeout:

```yaml
- id: stuga-mcp
  config:
    serverName: stuga
    transport: streamable-http
    url: https://notes.example.com/mcp
    headers:
      Authorization: !!js '"Bearer " + process.env.STUGA_API_KEY'
      x-stuga-client: deepseek-harness
    toolCallTimeoutMs: 120000
    failOnStartupError: false
```

## Limits

- The key is static. The harness's MCP client has no OAuth, so there is no browser sign-in; the key owner is the reviewer of every proposal the agent makes. Use one key per person, not a shared team key.
- Tool calls render as generic cards in the DeepSeek Harness web UI. The human-friendly signal is the result text and the links in the assistant's reply.
- Only the key's own workspace's conventions are in the system prompt. Another workspace's reach the model through `mcp__stuga__workspaces` with `action: "instructions"`, which the prompt section tells it to call before writing there, and to call for the key's own workspace too when the plugin could not read it.
- A folder's, database's or document's own instructions reach the model only through the tool answers above, so a model that writes to a document without reading it first misses them. The prompt section and the playbooks say to read a document before editing it.
- One key shares one request budget (600 requests per minute on `/mcp`, whichever workspaces its calls name) across every session and subagent using it.
- Tested against DeepSeek Harness `0.1.2-rc.1`. The harness is a developer preview with breaking changes between releases; this plugin touches only the `ctx.systemPrompt.section` and `ctx.skills.register` registries plus the `dsh-mcp-client` row, and degrades to the plain MCP row if either registry changes.

## Development

The package is plain JavaScript with no runtime dependencies and no build step.

```sh
npm test
```

The prompt section and the skill playbooks copy Stuga's tool and action names verbatim; the tests check them against the tools Stuga's MCP server ships (contract 2). `Config` is a hand-written [Standard Schema](https://standardschema.dev) object, which is what Cordis reads to validate a row's config, so the plugin does not depend on the harness's schema library.

## License

MIT. Stuga itself is AGPL-3.0; this plugin is a client-side configuration layer and carries no Stuga code.
