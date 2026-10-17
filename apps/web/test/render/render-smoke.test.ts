import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { preview, type PreviewServer } from "vite";
import { afterAll, beforeAll, vi, test } from "vitest";

let server: PreviewServer | undefined;

let baseUrl = process.env.GAVEL_RENDER_BASE_URL;

function localBaseUrl(): string {
  assert.ok(baseUrl, "Vite preview did not provide a local URL");

  return baseUrl;
}

beforeAll(async () => {
  if (baseUrl) {
    assert.equal(new URL(baseUrl).hostname, "127.0.0.1", "Smoke tests only use a local preview");
    await vi.waitFor(
      async () => {
        const response = await fetch(localBaseUrl(), { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
      },
      { timeout: 20000, interval: 100 },
    );

    return;
  }

  const readyServer = await preview({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    preview: { host: "127.0.0.1", port: 0, strictPort: true, open: false },
    plugins: [
      {
        name: "render-fixture-cleanup",
        enforce: "pre",
        configurePreviewServer(previewServer) {
          // Keep the handle before Cloudflare starts workerd, including failed startup.
          server = previewServer;
        },
      },
    ],
  });

  baseUrl = readyServer.resolvedUrls?.local[0];
  assert.equal(new URL(localBaseUrl()).hostname, "127.0.0.1");
}, 20000);

afterAll(async () => {
  await server?.close();
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

    assert.equal(response.status, 200, `SSR failed: ${html}`);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(html, /Gavel Live/);
    assert.ok(html.includes(heading), `Missing signed-out heading: ${heading}`);
    assert.match(html, /<script[^>]+type="module"/);
  },
);
