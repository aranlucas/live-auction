import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, test } from "vitest";

let preview: ChildProcess | undefined;

let baseUrl = process.env.GAVEL_RENDER_BASE_URL;

let output = "";

function localBaseUrl(): string {
  if (!baseUrl) {
    throw new Error("The local preview URL has not been initialized");
  }

  return baseUrl;
}

beforeAll(async () => {
  if (baseUrl) {
    assert.equal(new URL(baseUrl).hostname, "127.0.0.1", "Smoke tests only use a local preview");
  } else {
    const listener = createServer();
    await new Promise<void>((resolve) => {
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();
    assert.ok(address instanceof Object && "port" in address);
    const port = address.port;
    assert.ok(Number.isInteger(port) && port > 0);
    await new Promise<void>((resolve, reject) => {
      listener.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    baseUrl = `http://127.0.0.1:${String(port)}`;
    preview = spawn(
      "pnpm",
      ["exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const captureOutput = (chunk: Buffer) => {
      output = (output + String(chunk)).slice(-16000);
    };

    preview.stdout?.on("data", captureOutput);
    preview.stderr?.on("data", captureOutput);
  }

  const deadline = Date.now() + 20000;

  async function waitForPreview() {
    try {
      await fetch(localBaseUrl(), { signal: AbortSignal.timeout(1000) });
    } catch {
      if (preview?.exitCode !== null && preview?.exitCode !== undefined) {
        throw new Error(`Local preview did not start.\n${output}`);
      }

      if (Date.now() >= deadline) {
        throw new Error(`Local preview did not start.\n${output}`);
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      await waitForPreview();
    }
  }

  await waitForPreview();
});

afterAll(() => {
  preview?.kill("SIGTERM");
});

const cases = [
  ["/", "Start a live demo"],
  ["/auctions/render-fixture", "Connect to this auction"],
];

test.each(cases)(
  "compiled preview renders %s without credentials or auction requests",
  async (path, heading) => {
    const response = await fetch(new URL(path, localBaseUrl()), {
      signal: AbortSignal.timeout(10000),
    });

    const html = await response.text();

    assert.equal(response.status, 200, `SSR failed: ${html}\n${output}`);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(html, /Gavel Live/);
    assert.ok(html.includes(heading), `Missing signed-out heading: ${heading}`);
    assert.match(html, /<script[^>]+type="module"/);
  },
);
