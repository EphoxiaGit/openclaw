import { describe, expect, it } from "vitest";
import { CORE_GATEWAY_METHOD_SPECS } from "./core-descriptors.js";

describe("project-context gateway scopes", () => {
  it("keeps every G005 method on its exact operator scope", () => {
    const scopes = new Map(
      CORE_GATEWAY_METHOD_SPECS.filter((spec) =>
        new Set([
          "work.registeredProjects.list",
          "work.registeredProjects.get",
          "work.projects.createRegistered",
          "work.projectContext.get",
          "work.documents.list",
          "work.documents.get",
          "work.capsules.update",
          "work.checkpoints.create",
          "work.handoffs.create",
        ]).has(spec.name),
      ).map((spec) => [spec.name, spec.scope]),
    );
    expect(Object.fromEntries(scopes)).toEqual({
      "work.registeredProjects.list": "operator.read",
      "work.registeredProjects.get": "operator.read",
      "work.projects.createRegistered": "operator.write",
      "work.projectContext.get": "operator.read",
      "work.documents.list": "operator.read",
      "work.documents.get": "operator.read",
      "work.capsules.update": "operator.write",
      "work.checkpoints.create": "operator.write",
      "work.handoffs.create": "operator.write",
    });
  });
});
