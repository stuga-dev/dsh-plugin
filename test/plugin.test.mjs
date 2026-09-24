import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import * as plugin from "../index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  assert.match(text, /mcp__stuga__markdown/);
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

test("skill names match their directories and use the action verbs Stuga ships", async () => {
  const skills = await plugin.loadBundledSkills(path.join(ROOT, "skills"));
  assert.deepEqual(
    skills.map((s) => s.name),
    ["stuga-databases", "stuga-propose-edits", "stuga-research"],
  );
  const byName = Object.fromEntries(skills.map((s) => [s.name, s.content]));
  // Verbatim action enums from stuga's packages/agent-surface/src/catalog.ts.
  for (const action of ["read", "write", "str_replace", "append", "status", "provenance"]) {
    assert.match(byName["stuga-propose-edits"], new RegExp(`"${action}"`), `markdown action ${action}`);
  }
  for (const action of ["list", "schema", "status", "create_database", "create_table", "add_column", "insert_rows", "update_rows", "delete_rows"]) {
    assert.match(byName["stuga-databases"], new RegExp(`"${action}"`), `databases action ${action}`);
  }
  for (const type of ["doc.created", "run.proposed", "run.decided", "comment.added", "database.changed"]) {
    assert.match(byName["stuga-research"], new RegExp(type.replace(".", "\\.")), `event type ${type}`);
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

describe_instructions: {
  test("fetchInstructions returns the workspace's conventions, and null on any failure", async () => {
    const seen = [];
    const ok = async (url, init) => {
      seen.push({ url, headers: init.headers });
      return { ok: true, json: async () => ({ instructions: "  House style: British spelling.  " }) };
    };
    assert.equal(
      await plugin.fetchInstructions("https://notes.example.com/", "vk_key", ok),
      "House style: British spelling.",
    );
    assert.equal(seen[0].url, "https://notes.example.com/api/instructions");
    assert.equal(seen[0].headers.authorization, "Bearer vk_key");

    // No key, a refusal, a blank answer and a thrown request all mean "no conventions".
    assert.equal(await plugin.fetchInstructions("https://x.test", "", ok), null);
    assert.equal(await plugin.fetchInstructions("https://x.test", "k", async () => ({ ok: false })), null);
    assert.equal(
      await plugin.fetchInstructions("https://x.test", "k", async () => ({ ok: true, json: async () => ({ instructions: "  " }) })),
      null,
    );
    assert.equal(
      await plugin.fetchInstructions("https://x.test", "k", async () => {
        throw new Error("unreachable");
      }),
      null,
    );
  });

  test("conventionsBlock is empty without conventions and labelled with them", () => {
    assert.equal(plugin.conventionsBlock(null), "");
    assert.equal(plugin.conventionsBlock(""), "");
    const block = plugin.conventionsBlock("Never touch Archive.");
    assert.match(block, /This workspace's conventions/);
    assert.match(block, /Never touch Archive\./);
  });

  test("apply fetches the conventions and folds them into the section text", async () => {
    const previous = process.env.STUGA_API_KEY;
    process.env.STUGA_API_KEY = "vk_test";
    try {
      const ctx = fakeCtx();
      plugin.apply(ctx, { url: "http://127.0.0.1:8799" });
      const [section] = ctx.sections;
      // Before the fetch settles the section is still usable — just without conventions.
      assert.doesNotMatch(section.text({}), /This workspace's conventions/);
      assert.equal(ctx.calls.effects.length, 1, "the refresh runs inside a disposable effect");
      await settle();
      // No node is listening on that port in a unit test, so the fetch fails and
      // the section must be unchanged rather than broken.
      assert.match(section.text({}), /"Proposed" is SUCCESS/);
      for (const dispose of ctx.calls.effects) dispose();
    } finally {
      if (previous === undefined) delete process.env.STUGA_API_KEY;
      else process.env.STUGA_API_KEY = previous;
    }
  });

  test("the conventions fetch can be switched off", () => {
    const ctx = fakeCtx();
    plugin.apply(ctx, { instructions: false });
    assert.equal(ctx.calls.effects.length, 0);
  });
}
