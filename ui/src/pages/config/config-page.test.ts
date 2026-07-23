/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { ConfigPage, configSelectionFromSearch, supportsSystemInfo } from "./config-page.ts";

describe("configSelectionFromSearch", () => {
  it("opens a valid linked Settings section", () => {
    expect(configSelectionFromSearch("communications", "?section=talk")).toEqual({
      activeSection: "talk",
      activeSubsection: null,
    });
  });

  it("opens a linked Settings subsection", () => {
    expect(configSelectionFromSearch("communications", "?section=messages&subsection=tts")).toEqual(
      {
        activeSection: "messages",
        activeSubsection: "tts",
      },
    );
  });

  it("falls back when a linked section does not belong to the page", () => {
    expect(configSelectionFromSearch("communications", "?section=gateway")).toEqual({
      activeSection: "messages",
      activeSubsection: null,
    });
  });

  it("routes workspace and security sections without duplicating approvals in automation", () => {
    expect(configSelectionFromSearch("workspace", "?section=workspace")).toEqual({
      activeSection: "workspace",
      activeSubsection: null,
    });
    expect(configSelectionFromSearch("security", "?section=approvals")).toEqual({
      activeSection: "approvals",
      activeSubsection: null,
    });
    expect(configSelectionFromSearch("automation", "?section=approvals")).toEqual({
      activeSection: "commands",
      activeSubsection: null,
    });
  });
});

describe("supportsSystemInfo", () => {
  it("requires the Gateway to advertise system.info", () => {
    const hello = {
      features: { methods: ["health", "system.info"] },
    } as ApplicationGatewaySnapshot["hello"];
    const unsupportedHello = {
      features: { methods: ["health"] },
    } as ApplicationGatewaySnapshot["hello"];

    expect(supportsSystemInfo(hello)).toBe(true);
    expect(supportsSystemInfo(unsupportedHello)).toBe(false);
    expect(supportsSystemInfo(null)).toBe(false);
  });
});

describe("ConfigPage system info", () => {
  it("clears stale host info when the Gateway disconnects", () => {
    const client = {} as GatewayBrowserClient;
    const snapshot = {
      client,
      connected: false,
      hello: null,
    } as ApplicationGatewaySnapshot;
    const page = new ConfigPage();
    const state = page as unknown as {
      context: { gateway: { snapshot: ApplicationGatewaySnapshot } };
      systemInfo: SystemInfoResult | null;
      systemInfoClient: GatewayBrowserClient | null;
      handleSystemInfoGatewaySnapshot: (snapshot: ApplicationGatewaySnapshot) => void;
    };
    state.context = { gateway: { snapshot } };
    state.systemInfoClient = client;
    state.systemInfo = {} as SystemInfoResult;

    state.handleSystemInfoGatewaySnapshot(snapshot);

    expect(state.systemInfo).toBeNull();
  });
});

describe("ConfigPage application config refresh", () => {
  type ConfigPageRefreshHarness = {
    context: {
      runtimeConfig: Record<"save" | "apply", () => Promise<boolean>>;
      config: { refresh: (options: unknown) => Promise<void> };
      gateway: {
        snapshot: { hello: { auth: { deviceToken: string } } };
        connection: { token: string; password: string };
      };
    };
    saveConfig: () => Promise<void>;
    applyConfig: () => Promise<void>;
  };

  function createRefreshHarness(result: boolean) {
    const refresh = vi.fn(async (_options: unknown) => undefined);
    const page = new ConfigPage() as unknown as ConfigPageRefreshHarness;
    page.context = {
      runtimeConfig: {
        save: vi.fn(async () => result),
        apply: vi.fn(async () => result),
      },
      config: { refresh },
      gateway: {
        snapshot: { hello: { auth: { deviceToken: "live-device-token" } } },
        connection: { token: "latest-token", password: "latest-password" },
      },
    };
    return { page, refresh };
  }

  it.each([
    ["saveConfig", "save"],
    ["applyConfig", "apply"],
  ] as const)("refreshes the bootstrap projection after successful %s", async (method, action) => {
    const { page, refresh } = createRefreshHarness(true);

    await page[method]();

    expect(page.context.runtimeConfig[action]).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith({
      auth: {
        hello: { auth: { deviceToken: "live-device-token" } },
        settings: { token: "latest-token" },
        password: "latest-password",
      },
    });
  });

  it.each([
    ["saveConfig", "save"],
    ["applyConfig", "apply"],
  ] as const)(
    "does not refresh the bootstrap projection after failed %s",
    async (method, action) => {
      const { page, refresh } = createRefreshHarness(false);

      await page[method]();

      expect(page.context.runtimeConfig[action]).toHaveBeenCalledOnce();
      expect(refresh).not.toHaveBeenCalled();
    },
  );
});
