import { readFile } from "node:fs/promises";
import { importJWK, SignJWT, type JWK } from "jose";
import { z } from "zod";

const privateJwkSchema = z
  .object({
    kty: z.string(),
    kid: z.string(),
    alg: z.literal("ES256"),
    d: z.string(),
  })
  .passthrough();

export async function issueToken(
  subject: string,
  role: "seller" | "bidder" | "viewer",
  options: {
    issuer: string;
    audience: string;
    privateJwkPath?: string;
    expiresIn?: string;
  },
): Promise<string> {
  const path = options.privateJwkPath ?? ".auction-auth-private.jwk";
  const jwk = privateJwkSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const key = await importJWK(jwk as JWK, "ES256");
  return new SignJWT({ role })
    .setProtectedHeader({ alg: "ES256", kid: jwk.kid })
    .setSubject(subject)
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "15m")
    .sign(key);
}
