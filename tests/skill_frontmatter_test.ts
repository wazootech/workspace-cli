import { assert, assertEquals } from "@std/assert";
import { expandGlob } from "@std/fs";
import { basename, dirname, join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";

/**
 * Skill packaging contract: every skills/**\/SKILL.md must carry frontmatter
 * that strict YAML parsers (e.g. the `skills` install CLI) accept. Bare
 * colons inside unquoted scalars read as nested mappings and break
 * `npx skills add <owner>/<repo>@<skill>` — see issue #47.
 */

interface SkillFrontmatter {
  name: string;
  description: string;
}

async function loadFrontmatter(skillMdPath: string): Promise<SkillFrontmatter> {
  const raw = await Deno.readTextFile(skillMdPath);
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  assert(match !== null, `${skillMdPath}: missing frontmatter block`);
  const parsed = parseYaml(match[1]) as Partial<SkillFrontmatter>;
  assert(
    typeof parsed.name === "string" && parsed.name.length > 0,
    `${skillMdPath}: frontmatter "name" must be a non-empty string`,
  );
  assertEquals(
    parsed.name,
    basename(dirname(skillMdPath)),
    `${skillMdPath}: frontmatter "name" must equal its directory name`,
  );
  assert(
    typeof parsed.description === "string" && parsed.description.length > 0,
    `${skillMdPath}: frontmatter "description" must be a non-empty string`,
  );
  return parsed as SkillFrontmatter;
}

Deno.test("every packaged SKILL.md has strictly-valid YAML frontmatter", async () => {
  const entries = [];
  for await (
    const entry of expandGlob(join("skills", "**", "SKILL.md"))
  ) {
    entries.push(entry.path);
  }
  assert(entries.length > 0, "expected at least one packaged skill");
  for (const path of entries) {
    await loadFrontmatter(path);
  }
});
