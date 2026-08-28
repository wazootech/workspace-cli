import { assertEquals } from "@std/assert";
import { parseWorktreesPorcelain } from "@/worktrees.ts";

const SAMPLE = `worktree C:/ws/repos/a
HEAD 0123456789abcdef0123456789abcdef01234567
branch refs/heads/main

worktree C:/ws/worktrees/a/feature-x
HEAD abcdefabcdefabcdefabcdefabcdefabcdefabcd
branch refs/heads/feature-x

worktree C:/ws/worktrees/a/detached
HEAD 1111111111111111111111111111111111111111
detached

worktree /mirror/a
bare
`;

Deno.test("parseWorktreesPorcelain parses main, feature, detached, bare", () => {
  const worktrees = parseWorktreesPorcelain(SAMPLE);
  assertEquals(worktrees.length, 4);
  assertEquals(worktrees[0], {
    path: "C:/ws/repos/a",
    branch: "main",
    head: "0123456789abcdef0123456789abcdef01234567",
    bare: false,
    detached: false,
  });
  assertEquals(worktrees[1].branch, "feature-x");
  assertEquals(worktrees[2].detached, true);
  assertEquals(worktrees[2].branch, undefined);
  assertEquals(worktrees[3].bare, true);
});

Deno.test("parseWorktreesPorcelain returns empty for empty input", () => {
  assertEquals(parseWorktreesPorcelain(""), []);
});

Deno.test("parseWorktreesPorcelain handles windows CRLF output", () => {
  const crlf = "worktree C:/ws/repos/a\r\nbranch refs/heads/main\r\n\r\n";
  const worktrees = parseWorktreesPorcelain(crlf);
  assertEquals(worktrees.length, 1);
  assertEquals(worktrees[0].branch, "main");
});
