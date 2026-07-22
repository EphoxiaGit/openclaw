import { definePage } from "@openclaw/uirouter";
import { html } from "lit";

export const page = definePage({
  id: "personas",
  path: "/personas",
  component: () =>
    import("./personas-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-personas-page></openclaw-personas-page>`,
    })),
});
