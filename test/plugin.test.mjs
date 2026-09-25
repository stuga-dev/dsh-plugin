import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import * as plugin from "../index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Stuga's MCP tools and their action enums, verbatim from stuga's
 * packages/agent-surface/src/catalog.ts (MCP_CONTRACT_VERSION 2).
 */
const CONTRACT_TOOLS = {
  workspaces: ["list", "instructions"],
  docs: ["list", "metadata"],
  search: [],
  markdown: ["read", "status", "provenance"],
  comments: [],
  folders: [],
  events: [],
  collections: ["list", "open"],
  retrieve: [],
  databases: ["list", "schema", "status", "page"],
  query: [],
  docs_create: [],
  markdown_append: [],
  markdown_edit: ["write", "str_replace", "cited_edits"],
  comments_add: [],
  media_upload: ["upload", "upload_from_url"],
  collections_edit: ["create", "rename", "delete", "add_items", "remove_items"],
  databases_add: ["create_database", "create_table", "add_column", "insert_rows", "import", "start_import", "create_view", "open_page"],
  databases_change: ["update_rows", "delete_rows", "update_view"],
};
const CONTRACT_ACTIONS = new Set(Object.values(CONTRACT_TOOLS).flat());

/** Every tool named with its `mcp__<server>__` prefix, and every action named as `action: "x"` or `action "x"`. */
function namedToolsAndActions(text) {
  const tools = [...text.matchAll(/mcp__(?:\{\{SERVER\}\}|stuga)__(\w+)/g)].map((m) => m[1]);
  const actions = [...text.matchAll(/action:? "(\w+)"/g)].map((m) => m[1]);
  return { tools, actions };
}

function fakeCtx() {
  const calls = { sections: [], skills: [], effects: [] };
  return {
    calls,
    get sections() {
      return calls.sections;
    },
    systemPrompt: { section: (s) => (calls.sections.push(s), () => {}) },
    skills: { register: (s) => (calls.skills.push(s), () => {}) },
    // Cordis runs the body and keeps the disposer it returns.
    effect: (body) => {
      const dispose = body();
      calls.effects.push(dispose);
      return dispose;
    },
  };
}

/** Wait for the microtasks + timers an effect body kicked off. */
const settle = () => new Promise((r) => setTimeout(r, 0));

test("plugin module shape", () => {
  assert.equal(plugin.name, "stuga-guidance");
  assert.deepEqual(plugin.inject, ["systemPrompt", "skills"]);
  assert.equal(typeof plugin.apply, "function");
  // Cordis reads Config['~standard'].validate (Standard Schema v1).
  assert.equal(plugin.Config["~standard"].version, 1);
  assert.equal(typeof plugin.Config["~standard"].validate, "function");
});

test("Config fills defaults and reports issues in the Standard Schema shape", () => {
  const defaults = { url: "http://127.0.0.1:8787", serverName: "stuga", section: true, skills: true, instructions: true, instructionsRefreshMs: 300000 };
  assert.deepEqual(plugin.Config["~standard"].validate(undefined), { value: defaults });

  const custom = plugin.Config["~standard"].validate({ url: "https://notes.example.com/", serverName: "notes", skills: false });
  assert.deepEqual(custom, {
    value: { ...defaults, url: "https://notes.example.com", serverName: "notes", skills: false },
  });

  assert.ok(plugin.Config["~standard"].validate({ instructionsRefreshMs: 500 }).issues, "refresh floor is enforced");

  const bad = plugin.Config["~standard"].validate({ serverName: "bad name!", url: "notes.example.com", extra: 1 });
  assert.ok(bad.issues);
  assert.deepEqual(
    bad.issues.map((i) => i.path[0]).sort(),
    ["extra", "serverName", "url"],
  );
  assert.ok(plugin.Config["~standard"].validate([]).issues);
});

test("apply registers one section and the three bundled skills", () => {
  const ctx = fakeCtx();
  plugin.apply(ctx, { url: "https://notes.example.com/", serverName: "stuga" });

  assert.equal(ctx.sections.length, 1);
  const [section] = ctx.sections;
  assert.equal(section.name, plugin.SECTION_NAME);
  assert.equal(section.order, plugin.SECTION_ORDER);
  // The text is a provider so a later conventions fetch reaches the next request.
  assert.equal(typeof section.text, "function");
  const text = section.text({});
  assert.match(text, /mcp__stuga__markdown_edit/);
  assert.match(text, /`workspace_ids` instead, where \["\*"\] covers every workspace this key reaches/);
  assert.match(text, /"Proposed" is SUCCESS/);
  assert.match(text, /https:\/\/notes\.example\.com\/review/);
  assert.doesNotMatch(text, /example\.com\/\/doc/, "trailing slash is normalized away");

  const names = ctx.calls.skills.map((s) => s.name).sort();
  assert.deepEqual(names, ["stuga-databases", "stuga-propose-edits", "stuga-research"]);
  for (const skill of ctx.calls.skills) {
    assert.ok(skill.description.length > 20, `${skill.name} has a description`);
    assert.doesNotMatch(skill.content, /\{\{STUGA_URL\}\}|\{\{SERVER\}\}/, `${skill.name} placeholders substituted`);
    assert.match(skill.content, /mcp__stuga__/, `${skill.name} names the tool prefix`);
    assert.match(skill.content, /https:\/\/notes\.example\.com/);
  }
});

test("apply refuses an invalid config loudly", () => {
  assert.throws(() => plugin.apply(fakeCtx(), { serverName: "no spaces allowed" }), /invalid config/);
});

test("section and skills can be switched off", () => {
  const ctx = fakeCtx();
  plugin.apply(ctx, { section: false, skills: false });
  assert.equal(ctx.sections.length, 0);
  assert.equal(ctx.calls.skills.length, 0);
});

test("parseSkillFile reads frontmatter and body", () => {
  const parsed = plugin.parseSkillFile('---\nname: x-y\ndescription: "Does a thing."\n---\n\n# Body\n', "fallback");
  assert.deepEqual(parsed, { name: "x-y", description: "Does a thing.", content: "# Body" });
  const bare = plugin.parseSkillFile("no frontmatter", "fallback");
  assert.equal(bare.name, "fallback");
  assert.equal(bare.content, "no frontmatter");
});

test("skill names match their directories and use the tools and actions Stuga ships", async () => {
  const skills = await plugin.loadBundledSkills(path.join(ROOT, "skills"));
  assert.deepEqual(
    skills.map((s) => s.name),
    ["stuga-databases", "stuga-propose-edits", "stuga-research"],
  );
  const byName = Object.fromEntries(skills.map((s) => [s.name, s.content]));
  const mentions = (skill, tool) => assert.match(byName[skill], new RegExp(`\`${tool}\``), `${skill} names ${tool}`);
  const usesAction = (skill, action) => assert.match(byName[skill], new RegExp(`action:? "${action}"`), `${skill} uses action ${action}`);

  for (const tool of ["markdown", "markdown_edit", "markdown_append", "docs_create", "media_upload", "workspaces"]) mentions("stuga-propose-edits", tool);
  for (const action of [...CONTRACT_TOOLS.markdown, ...CONTRACT_TOOLS.markdown_edit, ...CONTRACT_TOOLS.media_upload]) {
    usesAction("stuga-propose-edits", action);
  }

  for (const tool of ["databases", "databases_add", "databases_change", "query"]) mentions("stuga-databases", tool);
  for (const action of [...CONTRACT_TOOLS.databases, ...CONTRACT_TOOLS.databases_add, ...CONTRACT_TOOLS.databases_change]) {
    usesAction("stuga-databases", action);
  }

  for (const tool of ["search", "retrieve", "docs", "markdown", "collections", "folders", "events", "workspaces"]) mentions("stuga-research", tool);
  assert.match(byName["stuga-research"], /`workspace_ids`/);
  assert.match(byName["stuga-research"], /\["\*"\]/);
  for (const type of ["doc.created", "run.proposed", "run.decided", "comment.added", "database.changed"]) {
    assert.match(byName["stuga-research"], new RegExp(type.replace(".", "\\.")), `event type ${type}`);
  }
});

test("the section and the skills name only the tools and actions Stuga ships", async () => {
  const skills = await plugin.loadBundledSkills(path.join(ROOT, "skills"));
  const texts = [["section", plugin.sectionText({ url: "http://127.0.0.1:8787", serverName: "stuga" })], ...skills.map((s) => [s.name, s.content])];
  for (const [label, text] of texts) {
    const { tools, actions } = namedToolsAndActions(text);
    for (const tool of tools) assert.ok(tool in CONTRACT_TOOLS, `${label} names unknown tool ${tool}`);
    for (const action of actions) assert.ok(CONTRACT_ACTIONS.has(action), `${label} names unknown action ${action}`);
    // No workspace is implied any more: every call names its own.
    assert.doesNotMatch(text, /home workspace/i, `${label} mentions a home workspace`);
    // Retired tools the patterns above cannot see: `media` is `media_upload`, `docs` create is `docs_create`.
    assert.doesNotMatch(text, /`media`/, `${label} names the retired media tool`);
    assert.doesNotMatch(text, /`docs`[^.\n]*action:? "create"/, `${label} creates through docs`);
  }
});

test("cordis.patch.yml carries the two rows and the bundle manifest points at it", async () => {
  const patch = await readFile(path.join(ROOT, "cordis.patch.yml"), "utf8");
  assert.match(patch, /^- insert:/m);
  assert.match(patch, /id: stuga-mcp\n\s+name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(patch, /transport: streamable-http/);
  assert.match(patch, /STUGA_API_KEY/);
  assert.match(patch, /id: stuga-guidance\n\s+name: '@stuga\/dsh-plugin'/);

  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.name, "@stuga/dsh-plugin");
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.deepEqual(pkg.dependencies, {}, "the plugin ships with no runtime dependencies");
  assert.ok(pkg.files.includes("skills/"));
  assert.ok(pkg.files.includes("cordis.patch.yml"));
});

/** Run `body` with STUGA_API_KEY set and, when given, a stand-in for the global fetch. */
async function withKeyAndFetch(fetchImpl, body) {
  const previousKey = process.env.STUGA_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.STUGA_API_KEY = "vk_test";
  if (fetchImpl) globalThis.fetch = fetchImpl;
  try {
    await body();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STUGA_API_KEY;
    else process.env.STUGA_API_KEY = previousKey;
  }
}

const answering = (body) => async () => ({ ok: true, json: async () => body });

describe_workspace: {
  test("fetchWorkspace returns the key's workspace and its conventions, and null on any failure", async () => {
    const seen = [];
    const ok = async (url, init) => {
      seen.push({ url, headers: init.headers });
      return { ok: true, json: async () => ({ workspace_id: " ws_1 ", name: " Studio ", instructions: "  House style: British spelling.  " }) };
    };
    assert.deepEqual(await plugin.fetchWorkspace("https://notes.example.com/", "vk_key", ok), {
      workspaceId: "ws_1",
      name: "Studio",
      instructions: "House style: British spelling.",
    });
    assert.equal(seen[0].url, "https://notes.example.com/api/instructions");
    assert.equal(seen[0].headers.authorization, "Bearer vk_key");

    // A workspace without conventions is still a workspace: its id is what routes the calls.
    assert.deepEqual(await plugin.fetchWorkspace("https://x.test", "k", answering({ workspace_id: "ws_2", name: "Notes", instructions: "  " })), {
      workspaceId: "ws_2",
      name: "Notes",
      instructions: "",
    });

    // No key, a refusal, an answer without a workspace and a thrown request all mean "not read".
    assert.equal(await plugin.fetchWorkspace("https://x.test", "", ok), null);
    assert.equal(await plugin.fetchWorkspace("https://x.test", "k", async () => ({ ok: false })), null);
    assert.equal(await plugin.fetchWorkspace("https://x.test", "k", answering({ instructions: "No id." })), null);
    assert.equal(
      await plugin.fetchWorkspace("https://x.test", "k", async () => {
        throw new Error("unreachable");
      }),
      null,
    );
  });

  test("workspaceBlock names the workspace, with its conventions or without", () => {
    assert.equal(plugin.workspaceBlock(null), "");

    const bare = plugin.workspaceBlock({ workspaceId: "ws_1", name: "Studio", instructions: "" });
    assert.match(bare, /### The key's workspace/);
    assert.match(bare, /minted in "Studio", `workspace_id` `ws_1`/);
    assert.match(bare, /no conventions for agents/);

    const block = plugin.workspaceBlock({ workspaceId: "ws_1", name: 'Line\n"two"', instructions: "Never touch Archive." });
    assert.match(block, /minted in "Line\\n\\"two\\"", /, "a name stays on its one line");
    assert.match(block, /Follow them when working in it/);
    assert.match(block, /Never touch Archive\./);

    assert.match(plugin.workspaceBlock({ workspaceId: "ws_1", name: "", instructions: "" }), /minted in `workspace_id` `ws_1`/);
  });

  test("apply without a reachable node leaves the section usable", async () => {
    await withKeyAndFetch(null, async () => {
      const ctx = fakeCtx();
      plugin.apply(ctx, { url: "http://127.0.0.1:8799" });
      const [section] = ctx.sections;
      assert.equal(ctx.calls.effects.length, 1, "the refresh runs inside a disposable effect");
      await settle();
      // No node is listening on that port in a unit test, so the fetch fails and
      // the section must be unchanged rather than broken.
      assert.match(section.text({}), /"Proposed" is SUCCESS/);
      assert.doesNotMatch(section.text({}), /The key's workspace/);
      for (const dispose of ctx.calls.effects) dispose();
    });
  });

  test("apply folds the key's workspace into the section text", async () => {
    await withKeyAndFetch(answering({ workspace_id: "ws_1", name: "Studio", instructions: "Notes go in Log/." }), async () => {
      const ctx = fakeCtx();
      plugin.apply(ctx, { url: "https://notes.example.com" });
      const [section] = ctx.sections;
      // Before the fetch settles the section is still usable — just without the workspace.
      assert.doesNotMatch(section.text({}), /The key's workspace/);
      await settle();
      const text = section.text({});
      assert.match(text, /`workspace_id` `ws_1`/);
      assert.match(text, /Notes go in Log\/\./);
      for (const dispose of ctx.calls.effects) dispose();
    });
  });

  test("the conventions fetch can be switched off", () => {
    const ctx = fakeCtx();
    plugin.apply(ctx, { instructions: false });
    assert.equal(ctx.calls.effects.length, 0);
  });
}
