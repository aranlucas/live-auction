import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

let preview;

let baseUrl = process.env.GAVEL_RENDER_BASE_URL;

let output = "";

before(async () => {
  if (baseUrl) {
    assert.equal(new URL(baseUrl).hostname, "127.0.0.1", "Smoke tests only use a local preview");
  } else {
    const listener = createServer();
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    baseUrl = `http://127.0.0.1:${port}`;
    preview = spawn(
      "pnpm",
      ["exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    for (const stream of [preview.stdout, preview.stderr]) {
      stream.on("data", (chunk) => {
        output = (output + String(chunk)).slice(-16000);
      });
    }
  }

  const deadline = Date.now() + 20000;

  while (Date.now() < deadline) {
    try {
      await fetch(baseUrl, { signal: AbortSignal.timeout(1000) });

      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (preview?.exitCode !== null && preview?.exitCode !== undefined) break;
  }

  throw new Error(`Local preview did not start.\n${output}`);
});

after(() => {
  preview?.kill("SIGTERM");
});

for (const [path, heading] of [
  ["/", "Start a live demo"],
  ["/auctions/render-fixture", "Connect to this auction"],
]) {
  test(`compiled preview renders ${path} without credentials or auction requests`, async () => {
    const response = await fetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(10000) });
    const html = await response.text();
    assert.equal(response.status, 200, `SSR failed: ${html}\n${output}`);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(html, /Gavel Live/);
    assert.ok(html.includes(heading), `Missing signed-out heading: ${heading}`);
    assert.match(html, /<script[^>]+type="module"/);
  });
}
