import { installSessionStartHooks } from "axi-sdk-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupCommand } from "../../src/commands/setup.js";

vi.mock("axi-sdk-js", async () => {
  const actual = await vi.importActual<typeof import("axi-sdk-js")>(
    "axi-sdk-js",
  );
  return {
    ...actual,
    installSessionStartHooks: vi.fn(),
  };
});

const installMock = vi.mocked(installSessionStartHooks);

describe("setup", () => {
  beforeEach(() => {
    installMock.mockReset();
  });

  it("reports installed when hooks install cleanly", async () => {
    const out = await setupCommand(["hooks"]);

    expect(installMock).toHaveBeenCalledWith({
      onError: expect.any(Function),
    });
    expect(out).toContain("status: installed");
  });

  it("reports hook install failures", async () => {
    installMock.mockImplementation((options) => {
      options?.onError?.("/tmp/settings.json: denied");
      options?.onError?.("/tmp/config.toml: denied");
    });

    const out = await setupCommand(["hooks"]);

    expect(out).toContain("status: partial");
    expect(out).toContain("failures[2]{message}:");
    expect(out).toContain("/tmp/settings.json: denied");
    expect(out).toContain("/tmp/config.toml: denied");
    expect(out).not.toContain("status: installed");
  });
});
