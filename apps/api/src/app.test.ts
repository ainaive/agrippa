import { describe, expect, it } from "bun:test";
import { createApp } from "./app";

describe("api", () => {
  it("responds on /healthz", async () => {
    const res = await createApp().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
