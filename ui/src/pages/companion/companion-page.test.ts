import { describe, expect, it } from "vitest";
import { COMPANION_LOCAL_STAGE_URL } from "../../app/companion-stage.ts";
import "./companion-page.ts";

function createPage(localStageEnabled: boolean) {
  const page = document.createElement("openclaw-companion-page") as HTMLElement & {
    routeData?: { localStageEnabled: boolean };
    updateComplete: Promise<unknown>;
  };
  page.routeData = { localStageEnabled };
  document.body.append(page);
  return page;
}

describe("Companion page", () => {
  it("keeps the renderer disabled until the local route gate is present", async () => {
    const page = createPage(false);
    await page.updateComplete;

    expect(page.querySelector("iframe")).toBeNull();
    expect(page.textContent).toContain("Local Companion renderer is disabled.");
    page.remove();
  });

  it("embeds only the fixed local renderer with a restrictive iframe boundary", async () => {
    const page = createPage(true);
    await page.updateComplete;

    const frame = page.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("src")).toBe(COMPANION_LOCAL_STAGE_URL);
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(frame?.getAttribute("allow")).toBe("autoplay");
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(page.getAttribute("data-frame-state")).toBeNull();

    frame?.dispatchEvent(new Event("load"));
    await page.updateComplete;
    expect(page.querySelector(".companion-host")?.getAttribute("data-frame-state")).toBe("ready");
    page.remove();
  });
});
