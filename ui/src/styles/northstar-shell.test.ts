import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const shellStylePaths = [
  "base.css",
  "layout.css",
  "layout.mobile.css",
  "components.css",
  "chat/layout.css",
  "chat/sidebar.css",
  "chat/split-view.css",
];

async function readShellStyles(): Promise<string> {
  const stylesDirectory = path.join(process.cwd(), "src/styles");
  return (
    await Promise.all(
      shellStylePaths.map((relativePath) =>
        readFile(path.join(stylesDirectory, relativePath), "utf8"),
      ),
    )
  ).join("\n");
}

describe("Project Northstar shell styles", () => {
  it("uses explicit selectors instead of wildcard theme hooks", async () => {
    const css = await readShellStyles();

    expect(css).not.toMatch(/\[class\*=/);
    expect(css).not.toMatch(/background-clip\s*:\s*text/);
  });

  it("keeps accessibility fallbacks source-owned", async () => {
    const css = await readShellStyles();

    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain("@media (max-width: 1120px)");
    expect(css).toContain("@media (max-width: 768px)");
  });
});
