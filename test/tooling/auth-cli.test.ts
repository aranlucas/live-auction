import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importJWK, jwtVerify } from "jose";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function keyFiles() {
  const directory = mkdtempSync(join(tmpdir(), "auction-auth-cli-"));
  temporaryDirectories.push(directory);
  const privatePath = join(directory, "private.jwk");
  const publicPath = join(directory, "public.jwks.json");

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/auth-keygen.ts", privatePath, publicPath],
    { encoding: "utf8" },
  );

  expect(result.status, result.stderr).toBe(0);

  return { privatePath, publicPath };
}

it("creates a private signing key and a matching public-only JWKS", () => {
  const { privatePath, publicPath } = keyFiles();

  const privateKey = z
    .object({ d: z.string(), kid: z.string() })
    .parse(JSON.parse(readFileSync(privatePath, "utf8")));

  const jwks = z
    .object({ keys: z.array(z.object({ kid: z.string(), d: z.string().optional() })) })
    .parse(JSON.parse(readFileSync(publicPath, "utf8")));

  expect(jwks.keys).toHaveLength(1);
  expect(jwks.keys[0].kid).toBe(privateKey.kid);
  expect(jwks.keys[0].d).toBeUndefined();
});

it.skipIf(process.platform === "win32")("restricts the private key file to its owner", () => {
  const { privatePath } = keyFiles();
  expect(statSync(privatePath).mode & 0o777).toBe(0o600);
});

it("issues verifiable tokens with the requested auction identity, role, issuer and audience", async () => {
  const { privatePath, publicPath } = keyFiles();

  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/auth-token.ts",
      "--subject",
      "synthetic-seller",
      "--role",
      "seller",
      "--issuer",
      "https://auction.example.test",
      "--audience",
      "synthetic-auction",
      "--private-jwk-path",
      privatePath,
    ],
    { encoding: "utf8" },
  );

  expect(result.status, result.stderr).toBe(0);

  const jwks = z
    .object({ keys: z.array(z.record(z.string(), z.string())) })
    .parse(JSON.parse(readFileSync(publicPath, "utf8")));

  const key = await importJWK(jwks.keys[0], "ES256");

  const { payload } = await jwtVerify(result.stdout.trim(), key, {
    issuer: "https://auction.example.test",
    audience: "synthetic-auction",
  });

  expect(payload.sub).toBe("synthetic-seller");
  expect(payload.role).toBe("seller");
  expect(payload.exp).toBeDefined();
});

it("rejects an unsupported auction role before issuing a token", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/auth-token.ts",
      "--subject",
      "synthetic-user",
      "--role",
      "administrator",
    ],
    { encoding: "utf8" },
  );

  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("role");
});
