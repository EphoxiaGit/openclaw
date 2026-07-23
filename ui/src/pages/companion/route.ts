import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import {
  isCompanionLocalStageEnabled,
  readCompanionRendererSelection,
  type CompanionRendererSelection,
} from "../../app/companion-stage.ts";
import type { ApplicationContext } from "../../app/context.ts";

export type CompanionRouteData = {
  localStageEnabled: boolean;
  selection: CompanionRendererSelection;
};

async function loadCompanionRoute(
  context: ApplicationContext,
  search: string,
): Promise<CompanionRouteData> {
  const localStageEnabled = isCompanionLocalStageEnabled(search);
  if (localStageEnabled) {
    await context.runtimeConfig.ensureLoaded();
  }
  return {
    localStageEnabled,
    selection: readCompanionRendererSelection(context.runtimeConfig.state.configSnapshot?.config),
  };
}

export const page = definePage({
  id: "companion",
  path: "/companion",
  loaderDeps: (_context, location) => location.search,
  loader: (context, options) => loadCompanionRoute(context, options.location.search),
  component: () =>
    import("./companion-page.ts").then(() => ({
      header: true,
      render: (data: CompanionRouteData | undefined) =>
        html`<openclaw-companion-page .routeData=${data}></openclaw-companion-page>`,
    })),
});
