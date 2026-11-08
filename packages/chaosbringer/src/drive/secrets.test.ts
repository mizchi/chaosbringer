import { describe, expect, it } from "vitest";
import { classifySecretField, DriveSecrets } from "./secrets.js";

describe("classifySecretField", () => {
  it("reads a password field from its type or an autocomplete token ending in -password", () => {
    expect(classifySecretField("password", null)).toBe("password");
    expect(classifySecretField("PASSWORD", "")).toBe("password");
    expect(classifySecretField("text", "current-password")).toBe("password");
    expect(classifySecretField("text", "section-a new-password")).toBe("password");
  });

  it("reads a one-time code from autocomplete, whatever the type", () => {
    expect(classifySecretField("text", "one-time-code")).toBe("one_time_code");
    expect(classifySecretField("password", "one-time-code")).toBe("one_time_code");
  });

  it("leaves every other field alone", () => {
    expect(classifySecretField("email", "email")).toBeNull();
    expect(classifySecretField("text", "username")).toBeNull();
    expect(classifySecretField(null, null)).toBeNull();
  });
});

describe("DriveSecrets", () => {
  it("names a field's secrets by kind, a second distinct one _2, the same one again by its name", () => {
    const s = new DriveSecrets();
    expect(s.register("pw-one", "password")).toBe("{{password}}");
    expect(s.register("pw-two", "password")).toBe("{{password_2}}");
    expect(s.register("pw-one", "password")).toBe("{{password}}");
    expect(s.register("123456", "one_time_code")).toBe("{{one_time_code}}");
    expect(s.register("pw-three", "password")).toBe("{{password_3}}");
    expect(s.vars()).toEqual({ password: "pw-one", password_2: "pw-two", one_time_code: "123456", password_3: "pw-three" });
  });

  it("skips a name a --secret took", () => {
    const s = new DriveSecrets({ password: "from-env" });
    expect(s.register("typed", "password")).toBe("{{password_2}}");
    expect(s.register("from-env", "password")).toBe("{{password}}");
  });

  it("records known values as placeholders and types placeholders as values", () => {
    const s = new DriveSecrets({ token: "tok-1" });
    expect(s.template("Bearer tok-1")).toBe("Bearer {{token}}");
    expect(s.resolve("Bearer {{token}}")).toBe("Bearer tok-1");
    expect(() => s.resolve("{{other}}")).toThrow('variable "other" is not defined');
  });

  it("scrubs a value as written and as a URL encodes it, and leaves placeholders whole", () => {
    // A secret that is a placeholder's own name must not break `{{password}}`.
    const s = new DriveSecrets({ password: "password", api: "a b&c" });
    expect(s.scrub("typed password into {{password}}")).toBe("typed {{password}} into {{password}}");
    expect(s.scrub("/w?u=a%20b%26c&v=a+b%26c a b&c")).toBe("/w?u={{api}}&v={{api}} {{api}}");
    expect(s.scrub(s.scrub("password"))).toBe("{{password}}");
  });

  it("scrubs the longer of two overlapping secrets whole", () => {
    const s = new DriveSecrets({ short: "abcd", long: "abcdefgh" });
    expect(s.scrub("xabcdefghx abcd")).toBe("x{{long}}x {{short}}");
  });
});
