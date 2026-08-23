import { chmod, writeFile } from "node:fs/promises";
import { exportJWK, generateKeyPair } from "jose";

const privatePath = process.argv[2] ?? ".auction-auth-private.jwk";
const publicPath = process.argv[3] ?? ".auction-auth-public.jwks.json";
const { publicKey, privateKey } = await generateKeyPair("ES256", {
  extractable: true,
});
const kid = crypto.randomUUID();
const publicJwk = {
  ...(await exportJWK(publicKey)),
  alg: "ES256",
  use: "sig",
  kid,
};
const privateJwk = {
  ...(await exportJWK(privateKey)),
  alg: "ES256",
  use: "sig",
  kid,
};
const jwks = { keys: [publicJwk] };

await writeFile(privatePath, JSON.stringify(privateJwk), { mode: 0o600 });
await chmod(privatePath, 0o600);
await writeFile(publicPath, JSON.stringify(jwks, null, 2) + "\n");

console.log(
  JSON.stringify({
    privateKey: privatePath,
    publicJwks: publicPath,
    wranglerValue: JSON.stringify(jwks),
  }),
);
