import { describe, expect, it } from "vitest";
import { endpointKey } from "./sampler.js";

describe("endpointKey", () => {
  it("strips query string", () => {
    expect(endpointKey("https://x/api/users?id=1")).toBe("/api/users");
  });

  it("normalises numeric ids", () => {
    expect(endpointKey("https://x/api/users/42/orders/7")).toBe("/api/users/:id/orders/:id");
  });

  it("normalises uuids", () => {
    expect(
      endpointKey("https://x/api/users/123e4567-e89b-12d3-a456-426614174000"),
    ).toBe("/api/users/:uuid");
  });

  it("normalises long hex tokens", () => {
    expect(endpointKey("https://x/api/items/abcdef0123456789")).toBe("/api/items/:hex");
  });

  it("leaves non-id segments alone", () => {
    expect(endpointKey("https://x/api/users/me/profile")).toBe("/api/users/me/profile");
  });

  it("returns / for an empty path", () => {
    expect(endpointKey("https://x/")).toBe("/");
    expect(endpointKey("https://x")).toBe("/");
  });

  it("tolerates non-absolute URL strings", () => {
    expect(endpointKey("/api/users?x=1")).toBe("/api/users");
  });
});
