import { describe, expect, it } from "vitest";
import { d1Retry } from "./index";

const overload = () => new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long");

describe("d1Retry", () => {
  it("returns the first success", async () => {
    let calls = 0;
    await expect(d1Retry(async () => ++calls, [0, 0, 0])).resolves.toBe(1);
    expect(calls).toBe(1);
  });

  it("rethrows non-transient errors immediately", async () => {
    let calls = 0;
    await expect(
      d1Retry(async () => {
        calls++;
        throw new Error("D1_ERROR: UNIQUE constraint failed");
      }, [0, 0, 0]),
    ).rejects.toThrow("UNIQUE constraint");
    expect(calls).toBe(1);
  });

  it("retries transient overload and succeeds", async () => {
    let calls = 0;
    const result = await d1Retry(async () => {
      if (++calls < 3) throw overload();
      return "ok";
    }, [0, 0, 0]);
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up after the delay schedule is exhausted", async () => {
    let calls = 0;
    await expect(
      d1Retry(async () => {
        calls++;
        throw overload();
      }, [0, 0, 0]),
    ).rejects.toThrow("overloaded");
    expect(calls).toBe(3);
  });
});
