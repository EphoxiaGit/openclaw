import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerContextSafety } from "./api.js";

export default definePluginEntry({
  id: "context-safety",
  name: "Context Safety Firewall",
  description:
    "Bounds tool inputs, persisted tool results, aggregate turn output, and provider preflight context.",
  register: registerContextSafety,
});
