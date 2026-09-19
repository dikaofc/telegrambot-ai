import { describe, it, expect } from "vitest";
import { classifyTask, defaultRouting, chatWithFallback } from "../src/providers/router.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createServer } from "node:http";
import { once } from "node:events";

describe("provider routing", () => {
  it("classifies coding/reasoning/chat", () => {
    expect(classifyTask("fix the build, tests failing")).toBe("coding");
    expect(classifyTask("bikin auth yang aman")).toBe("coding");
    expect(classifyTask("halo, apa kabar?")).toBe("chat");
    expect(classifyTask("analyze and compare architectures")).toBe("reasoning");
  });
  it("default routing has fallbacks", () => {
    const r = defaultRouting("9router");
    expect(r.primary).toBe("9router");
    expect(r.fallback.length).toBeGreaterThan(0);
    expect(r.allowFallback).toBe(true);
  });
  it("streams tool_call from OpenAI-compatible SSE (real HTTP)", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/models") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "m" }] })); return; }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "c1", function: { name: "read_file", arguments: "{\"target\":\"a\"}" } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const p = new OpenAICompatibleProvider({ id: "t", name: "T", baseUrl: `http://127.0.0.1:${port}`, apiKey: "k", defaultModel: "m" });
    const events = [];
    for await (const e of p.chat({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [{ name: "read_file", description: "r", schema: {} }] })) events.push(e);
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(events.some((e) => e.type === "tool_call" && e.toolCall?.name === "read_file")).toBe(true);
    expect(await p.health()).toBe(true);
    expect(await p.models()).toContain("m");
    server.close();
  });
  it("falls back when primary is unreachable", async () => {
    const good = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "fallback-ok" }, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    good.listen(0);
    await once(good, "listening");
    const port = (good.address() as { port: number }).port;
    process.env.PROVIDER_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.PROVIDER_API_KEY = "k";
    process.env.PROVIDER_MODEL = "m";
    const texts: string[] = [];
    for await (const e of chatWithFallback(
      { model: "auto", messages: [{ role: "user", content: "hi" }] },
      { primary: "custom-broken-never", fallback: ["custom"], allowFallback: true },
    )) { if (e.type === "text" && e.text) texts.push(e.text); }
    expect(texts.join("")).toContain("fallback-ok");
    good.close();
    delete process.env.PROVIDER_BASE_URL;
  }, 30000);
});
