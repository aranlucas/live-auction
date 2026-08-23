import { importJWK, SignJWT, type JWK } from "jose";
import { z } from "zod";
import {
  demoBidderSessionSuccessSchema,
  demoSessionSuccessSchema,
  type ActorRole,
  type DemoBidderSessionSuccess,
  type DemoSessionSuccess,
} from "./model";

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
  const suffix = randomSuffix();
  const auctionId = `demo-${suffix}`;
  const expiresAt = expirationTime();
  const [sellerToken, bidderToken, viewerToken] = await Promise.all([
    issueToken(env, "seller", auctionId, `demo-seller-${suffix}`, expiresAt),
    issueToken(env, "bidder", auctionId, `demo-bidder-${suffix}`, expiresAt),
    issueToken(env, "viewer", auctionId, `demo-viewer-${suffix}`, expiresAt),
  ]);

  return demoSessionSuccessSchema.parse({
    ok: true,
    auctionId,
    expiresAt,
    sellerToken,
    bidderToken,
    viewerToken,
  });
}

export async function createDemoBidderSession(
  env: DemoSessionEnvironment,
  auctionId: string,
): Promise<DemoBidderSessionSuccess> {
  const suffix = randomSuffix();
  const bidderId = `guest-${suffix.slice(0, 8)}`;
  const expiresAt = expirationTime();
  const bidderToken = await issueToken(env, "bidder", auctionId, bidderId, expiresAt);

  return demoBidderSessionSuccessSchema.parse({
    ok: true,
    auctionId,
    bidderId,
    expiresAt,
    bidderToken,
  });
}

async function issueToken(
  env: DemoSessionEnvironment,
  role: ActorRole,
  auctionId: string,
  subject: string,
  expiresAt: number,
): Promise<string> {
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

    return new SignJWT({ role, auctionId })
      .setProtectedHeader({ alg: "ES256", kid: jwk.kid })
      .setSubject(subject)
      .setIssuer(env.AUTH_ISSUER)
      .setAudience(env.AUTH_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(signingKey);
  } catch (error) {
    if (error instanceof DemoSessionConfigurationError) throw error;
    throw new DemoSessionConfigurationError("Demo session signing is not configured correctly");
  }
}

function randomSuffix(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 20);
}

function expirationTime(): number {
  return Math.floor(Date.now() / 1_000) + 15 * 60;
}
