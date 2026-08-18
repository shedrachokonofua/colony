import { describe, expect, it } from "bun:test";
import { createContractStubHandle } from "./contract-stub.js";

describe("contract stub handle", () => {
  it("rejects absolute and escaping paths like a real engine", async () => {
    const handle = createContractStubHandle();
    await expect(handle.readFile("/etc/passwd")).rejects.toThrow(/absolute/);
    await expect(handle.readFile("../secret")).rejects.toThrow(/escapes/);
    await expect(handle.writeFile("/tmp/x", "y")).rejects.toThrow(/absolute/);
    await expect(
      handle.exec({ command: "true", cwd: "../up" }, () => undefined),
    ).rejects.toThrow(/escapes/);
  });

  it("records contained calls and enforces destroy semantics", async () => {
    const handle = createContractStubHandle({ execStdout: "ok" });
    const events: string[] = [];
    const result = await handle.exec({ command: "echo hi" }, (event) =>
      events.push(event.kind),
    );
    expect(result.exitCode).toBe(0);
    expect(events).toEqual(["stdout", "exit"]);
    await handle.readFile("notes.txt");
    await handle.writeFile("out/result.txt", "data");
    expect(handle.execs).toHaveLength(1);
    expect(handle.reads).toEqual(["notes.txt"]);
    expect(handle.writes[0]?.path).toBe("out/result.txt");

    await handle.destroy();
    await handle.destroy();
    expect(handle.destroyCalls).toBe(2);
    await expect(
      handle.exec({ command: "true" }, () => undefined),
    ).rejects.toThrow(/after destroy/);
  });
});
