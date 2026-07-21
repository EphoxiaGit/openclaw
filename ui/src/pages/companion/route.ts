import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { isCompanionLocalStageEnabled } from "../../app/companion-stage.ts";

export type CompanionRouteData = {
  localStageEnabled: boolean;
};

export const page = definePage({
  id: "companion",
  path: "/companion",
  loaderDeps: (_context, location) => location.search,
  loader: (_context, options): CompanionRouteData => ({
    localStageEnabled: isCompanionLocalStageEnabled(options.location.search),
  }),
  component: () =>
    import("./companion-page.ts").then(() => ({
      header: true,
      render: (data: CompanionRouteData | undefined) =>
        html`<openclaw-companion-page .routeData=${data}></openclaw-companion-page>`,
    })),
});
