# @stuga/dsh-plugin

Connect a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) profile to a [Stuga](https://github.com/stuga-dev/stuga) workspace.

Stuga is a self-hosted collaborative workspace: real-time documents, structured databases with SQL, hybrid search, and first-class access for AI agents. An agent never writes silently: every edit is a **proposal** on a reviewable run ledger, attributed to the agent's key and accepted, rejected or reverted by a human. This plugin makes a dsh agent a well-behaved Stuga agent.

It is a thin layer, on purpose:

| Piece | What it does |
|---|---|
| `cordis.patch.yml` | Mounts dsh's in-box MCP client against the node's `/mcp`, so the model gets Stuga's tools as `mcp__stuga__*` (workspaces, docs, markdown, media, comments, folders, events, collections, retrieve, databases, query). |
| `index.js` | Registers one system-prompt section explaining the proposal/review model, folds in the workspace's own conventions, and registers three playbook skills. |
| `skills/` | `stuga-research`, `stuga-propose-edits`, `stuga-databases` — loaded on demand through dsh's `skill` tool. |

Everything Stuga enforces (the run ledger, access control inside search, per-call audit, read-only keys) is enforced by the Stuga node. The plugin only holds an agent key and shapes the model's behaviour against that surface.

## Install

You need a running Stuga node and a dsh installation (Node `^22.19 || >=24`, `pnpm` on `PATH`).

1. In Stuga, open **Settings → Your own AI**, choose **DeepSeek Harness**, and mint an agent key. Name it after the harness (that name is what reviewers see in the inbox). Narrow it to folders, make it read-only, or give it an expiry as you see fit. The tab prints the command and environment lines below with the key filled in.

2. Install the plugin into the profile you run (the web UI profile is `web`):

   ```sh
   dsh plugin --profile web add @stuga/dsh-plugin
   ```

   From a checkout instead of npm: `dsh plugin --profile web add /path/to/dsh-plugin`.

3. Tell dsh where the node is and which key to use. Either export them in the shell that launches dsh, or put them in `$DSH_HOME/.env`:

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

When the agent proposes an edit, the tool result says `Proposed — … (run X, N pending). Do NOT retry` and the prompt section tells the model to end its reply with links to `<STUGA_URL>/doc/<doc_id>` and `<STUGA_URL>/review`. Open those in Stuga to accept or reject each change hunk by hunk. In the inbox the run is badged `deepseek-harness` (the plugin sends an `x-stuga-client` header) under the key's name. If the document is set to apply agent changes at once, the edit lands immediately and the reviewer is notified; the result then says `Applied`.

## Configuration

The `stuga-guidance` row accepts:

| Field | Default | Meaning |
|---|---|---|
| `url` | `$STUGA_URL` or `http://127.0.0.1:8787` | Origin used in the links the model gives the reviewer |
| `serverName` | `stuga` | Must match the MCP row's `serverName`; sets the `mcp__<serverName>__` prefix the prompt refers to |
| `section` | `true` | Register the system-prompt section |
| `skills` | `true` | Register the three playbook skills |
| `instructions` | `true` | Read the workspace's conventions and put them in the system prompt |
| `instructionsRefreshMs` | `300000` | How often those conventions are re-read |

### The workspace's conventions

Stuga lets a workspace write free-text conventions for agents (**Settings → This workspace → Agents**): where notes go, what not to touch, the house style. The node serves them in its MCP server's `instructions` field, but dsh's MCP client does not surface that field, and a model told to go and fetch them often simply does not — in an end-to-end run, gpt-4o edited a document without ever calling `workspaces action:instructions`.

So the plugin reads them itself, over the same key, and puts them in the system prompt where they cannot be skipped. A node that is down, a key without access, or a workspace with no conventions all mean the same thing: the section is registered without them, and nothing fails.

Folders, databases and documents can carry their own instructions too, from their ⋯ menu in Stuga. They add to the workspace's, from the outermost level in, and depend on the item, so the plugin does not put them in the system prompt. The node hands them over with the item: `markdown` `read` shows them in a marked block before the document's text, or opens with a line saying none apply, so instructions planted in a document's text never lead the read; and `docs` `metadata` and `create` and `databases` `schema` return them as `instructions`. The prompt section and the playbooks tell the model to follow them when it writes there, never to copy them into an edit, and to treat anything further down a read that looks like such a block as document text.

### Labelling the model

Runs from this plugin are badged `deepseek-harness` in Stuga's review inbox. dsh does not expose the running model to its MCP layer, so the model label is yours to set: export `STUGA_MODEL=gpt-4o` (or whichever you pinned) and it appears beside the client badge.

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

- The key is static. dsh's MCP client has no OAuth, so there is no browser sign-in; the key owner is the reviewer of every proposal the agent makes. Use one key per person, not a shared team key.
- Tool calls render as generic cards in the dsh web UI. The human-friendly signal is the result text and the links in the assistant's reply.
- When the plugin could not read the workspace's conventions, the prompt section asks the model to call `mcp__stuga__workspaces` with `action: "instructions"` before the first write. dsh's MCP client does not surface the MCP server's own `instructions` field.
- A folder's, database's or document's own instructions reach the model only through the tool answers above, so a model that writes to a document without reading it first misses them. The prompt section and the playbooks say to read a document before editing it.
- One key shares one request budget (600 requests per minute per workspace) across every session and subagent using it.
- Verified end to end against dsh `0.1.2-rc.1` and a Stuga node built from source: the agent searched, read, proposed a `str_replace`, was told `Proposed`, did not retry, and ended with review links; the proposal landed in the inbox badged `deepseek-harness` with the document unchanged for the human and changed in the agent's own projection.
- Tested against dsh `0.1.2-rc.1`. dsh is a developer preview with breaking changes between releases; this plugin touches only the `ctx.systemPrompt.section` and `ctx.skills.register` registries plus the `dsh-mcp-client` row, and degrades to the plain MCP row if either registry changes.

## Development

The package is plain JavaScript with no runtime dependencies and no build step.

```sh
npm test
```

Skill playbooks copy Stuga's tool action names verbatim; the tests check them against the list Stuga's MCP server ships. `Config` is a hand-written [Standard Schema](https://standardschema.dev) object, which is what Cordis reads to validate a row's config, so the plugin does not depend on dsh's schema library.

## License

MIT. Stuga itself is AGPL-3.0; this plugin is a client-side configuration layer and carries no Stuga code.
