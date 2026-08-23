import { importJWK, SignJWT, type JWK } from "jose";
import { z } from "zod";
import { demoSessionSuccessSchema, type ActorRole, type DemoSessionSuccess } from "./model";

const privateJwkSchema = z
  .object({
    kty: z.string(),
    kid: z.string().min(1),
    alg: z.literal("ES256"),
    d: z.string().min(1),
  })
  .passthrough();

export interface DemoSessionEnvironment {
  AUTH_ISSUER: string;
  AUTH_AUDIENCE: string;
  DEMO_AUTH_PRIVATE_JWK?: string;
}

export class DemoSessionConfigurationError extends Error {}

let cachedPrivateJwk: string | undefined;
let cachedSigningKey: Awaited<ReturnType<typeof importJWK>> | undefined;

export async function createDemoSession(env: DemoSessionEnvironment): Promise<DemoSessionSuccess> {
  const privateJwk = env.DEMO_AUTH_PRIVATE_JWK;
  if (!privateJwk) {
    throw new DemoSessionConfigurationError("Demo session signing is not configured");
  }

  let jwk: z.infer<typeof privateJwkSchema>;
  try {
    jwk = privateJwkSchema.parse(JSON.parse(privateJwk));
  } catch {
    throw new DemoSessionConfigurationError("Demo session signing is not configured correctly");
  }

  try {
    if (!cachedSigningKey || cachedPrivateJwk !== privateJwk) {
      cachedSigningKey = await importJWK(jwk as JWK, "ES256");
      cachedPrivateJwk = privateJwk;
    }
    const signingKey = cachedSigningKey;

    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
    const auctionId = `demo-${suffix}`;
    const expiresAt = Math.floor(Date.now() / 1_000) + 15 * 60;
    const issueToken = (role: ActorRole) =>
      new SignJWT({ role, auctionId })
        .setProtectedHeader({ alg: "ES256", kid: jwk.kid })
        .setSubject(`demo-${role}-${suffix}`)
        .setIssuer(env.AUTH_ISSUER)
        .setAudience(env.AUTH_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(expiresAt)
        .sign(signingKey);

    const [sellerToken, bidderToken, viewerToken] = await Promise.all([
      issueToken("seller"),
      issueToken("bidder"),
      issueToken("viewer"),
    ]);

    return demoSessionSuccessSchema.parse({
      ok: true,
      auctionId,
      expiresAt,
      sellerToken,
      bidderToken,
      viewerToken,
    });
  } catch (error) {
    if (error instanceof DemoSessionConfigurationError) throw error;
    throw new DemoSessionConfigurationError("Demo session signing is not configured correctly");
  }
}
