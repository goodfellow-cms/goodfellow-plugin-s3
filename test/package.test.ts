import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";

const read = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

describe("the package", () => {
  it("says the version it is", () => {
    expect(plugin.version).toBe(read("package.json").version);
  });

  it("publishes a manifest that says what the plugin asks to do", () => {
    // `npm run build` writes it; this keeps the committed copy in step.
    expect(read("goodfellow-plugin.json")).toEqual({
      version: 1,
      title: plugin.title,
      description: plugin.description,
      permissions: plugin.permissions,
      admin: true,
      screens: plugin.screens,
      tasks: plugin.tasks?.map(({ id, title }) => ({ id, title })),
      server: true,
      mediaStorage: true,
    });
  });

  it("is found as a Goodfellow plugin and says which releases it works with", () => {
    const pkg = read("package.json");
    expect(pkg.keywords).toContain("goodfellow-plugin");
    expect(pkg.peerDependencies["@goodfellow-cms/core"]).toMatch(/^\^0\.\d+\.\d+$/);
  });
});
