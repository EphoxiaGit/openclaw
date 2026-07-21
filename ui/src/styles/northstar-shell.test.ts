import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const shellStyleUrls = [
  new URL("./base.css", import.meta.url),
  new URL("./layout.css", import.meta.url),
  new URL("./layout.mobile.css", import.meta.url),
  new URL("./components.css", import.meta.url),
  new URL("./chat/layout.css", import.meta.url),
  new URL("./chat/sidebar.css", import.meta.url),
  new URL("./chat/split-view.css", import.meta.url),
];

async function readShellStyles(): Promise<string> {
  return (await Promise.all(shellStyleUrls.map((url) => readFile(url, "utf8")))).join("\n");
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
