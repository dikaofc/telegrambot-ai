import { describe, it, expect, beforeEach } from "vitest";
import { toolRisk, RiskLevel, policyForRisk } from "../src/security/risk.js";
import { classifyCommand } from "../src/security/command-parser.js";
import { assertSafeUrl, isBlockedHost } from "../src/security/ssrf.js";
import { validateFileName, assertSafeArchiveEntry, validateUploadSize, validateUploadExt, detectZipBomb } from "../src/security/upload-validation.js";
import { redactSecrets, isProtectedPath } from "../src/security/secrets.js";

describe("risk & policy", () => {
  it("classifies known tools", () => {
    expect(toolRisk("read_file")).toBe(RiskLevel.SAFE);
    expect(toolRisk("npm_install")).toBe(RiskLevel.MEDIUM);
    expect(toolRisk("git_push")).toBe(RiskLevel.HIGH);
    expect(toolRisk("shell")).toBe(RiskLevel.HIGH);
  });
  it("policy gates", () => {
    expect(policyForRisk(RiskLevel.SAFE)).toBe("auto");
    expect(policyForRisk(RiskLevel.LOW)).toBe("auto");
    expect(policyForRisk(RiskLevel.MEDIUM)).toBe("ask");
    expect(policyForRisk(RiskLevel.HIGH)).toBe("ask");
    expect(policyForRisk(RiskLevel.CRITICAL)).toBe("deny");
  });
});

describe("command safety parser", () => {
  it("blocks rm -rf /", () => {
    expect(classifyCommand("rm -rf /").risk).toBe(RiskLevel.CRITICAL);
  });
  it("blocks shutdown/mkfs", () => {
    expect(classifyCommand("sudo shutdown now").risk).toBe(RiskLevel.CRITICAL);
    expect(classifyCommand("mkfs.ext4 /dev/sda1").risk).toBe(RiskLevel.CRITICAL);
  });
  it("rates git push high, npm install medium, ls safe", () => {
    expect(classifyCommand("git push origin main").risk).toBe(RiskLevel.HIGH);
    expect(classifyCommand("npm install lodash").risk).toBe(RiskLevel.MEDIUM);
    expect(classifyCommand("ls -la").risk).toBe(RiskLevel.SAFE);
  });
  it("blocks host escape", () => {
    expect(classifyCommand("cat ../../etc/shadow").risk).toBe(RiskLevel.CRITICAL);
  });
});

describe("ssrf", () => {
  it("blocks localhost/private/metadata", () => {
    expect(isBlockedHost("127.0.0.1")).toBe(true);
    expect(isBlockedHost("localhost")).toBe(true);
    expect(isBlockedHost("169.254.169.254")).toBe(true);
    expect(isBlockedHost("10.0.0.5")).toBe(true);
    expect(isBlockedHost("192.168.1.1")).toBe(true);
    expect(isBlockedHost("example.com")).toBe(false);
  });
  it("assertSafeUrl throws on blocked", () => {
    expect(() => assertSafeUrl("http://127.0.0.1/admin")).toThrow();
    expect(() => assertSafeUrl("http://169.254.169.254/latest")).toThrow();
    expect(assertSafeUrl("https://example.com/docs").hostname).toBe("example.com");
  });
});

describe("upload validation", () => {
  it("rejects traversal & absolute", () => {
    expect(validateFileName("../../etc/passwd").ok).toBe(false);
    expect(validateFileName("/abs/path").ok).toBe(false);
    expect(validateFileName("project.zip").ok).toBe(true);
  });
  it("archive entry stays inside root", () => {
    expect(() => assertSafeArchiveEntry("../evil.sh", "/tmp/root")).toThrow();
    expect(assertSafeArchiveEntry("a/b.txt", "/tmp/root")).toContain("b.txt");
  });
  it("size/ext/zipbomb", () => {
    expect(validateUploadSize(5 * 1024 * 1024, 100).ok).toBe(true);
    expect(validateUploadSize(200 * 1024 * 1024, 100).ok).toBe(false);
    expect(validateUploadExt("x.exe").ok).toBe(false);
    expect(validateUploadExt("proj.zip").ok).toBe(true);
    expect(detectZipBomb(500 * 1024 * 1024, 1 * 1024 * 1024)).toBe(true);
    expect(detectZipBomb(1024, 1024)).toBe(false);
  });
});

describe("secrets", () => {
  it("redacts tokens and api keys", () => {
    const out = redactSecrets("api_key=sk-abcdef123456 token=mytoken password=hunter2");
    expect(out).not.toContain("abcdef123456");
    expect(out).toContain("********");
  });
  it("protects .env/.ssh", () => {
    expect(isProtectedPath("/ws/.env")).toBe(true);
    expect(isProtectedPath("/ws/.ssh/id_rsa")).toBe(true);
    expect(isProtectedPath("/ws/src/index.ts")).toBe(false);
  });
});
