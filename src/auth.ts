import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { actorSchema, type Actor } from "./model";

const jwtClaimsSchema = z.object({
  sub: z.string().min(1).max(200),
  role: actorSchema.shape.role,
  auctionId: actorSchema.shape.auctionId,
});

const jwksSchema = z.strictObject({
  keys: z.array(z.record(z.string(), z.unknown())).min(1),
});

type JwkVerifier = ReturnType<typeof createLocalJWKSet> | ReturnType<typeof createRemoteJWKSet>;

const verifierCache = new Map<string, JwkVerifier>();

export class AuthenticationError extends Error {
  constructor(
    readonly code: "UNAUTHENTICATED" | "AUTH_CONFIGURATION_ERROR",
    message: string,
  ) {
    super(message);
  }
}

export async function authenticate(request: Request, env: Env): Promise<Actor> {
  const token = extractBearerToken(request);
  if (!token) {
    throw new AuthenticationError(
      "UNAUTHENTICATED",
      "Provide a Bearer token or the authenticated WebSocket subprotocol",
    );
  }

  const verifier = createVerifier(env);
  try {
    const { payload } = await jwtVerify(token, verifier, {
      issuer: env.AUTH_ISSUER,
      audience: env.AUTH_AUDIENCE,
      algorithms: ["ES256", "RS256"],
    });
    const claims = jwtClaimsSchema.parse(payload);
    return actorSchema.parse({
      id: claims.sub,
      role: claims.role,
      auctionId: claims.auctionId,
    });
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw new AuthenticationError("UNAUTHENTICATED", "The access token is invalid or expired");
  }
}

export function websocketProtocols(request: Request): string[] {
  return (request.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

function extractBearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length);

  const authProtocol = websocketProtocols(request).find((protocol) => protocol.startsWith("auth."));
  return authProtocol ? authProtocol.slice("auth.".length) : null;
}

function createVerifier(env: Env) {
  const jwksUrl = String(env.AUTH_JWKS_URL);
  if (jwksUrl) {
    try {
      const cacheKey = `remote:${jwksUrl}`;
      const cached = verifierCache.get(cacheKey);
      if (cached) return cached;
      const verifier = createRemoteJWKSet(new URL(jwksUrl));
      verifierCache.set(cacheKey, verifier);
      return verifier;
    } catch {
      throw new AuthenticationError("AUTH_CONFIGURATION_ERROR", "AUTH_JWKS_URL is invalid");
    }
  }

  if (!env.AUTH_JWKS_JSON) {
    throw new AuthenticationError(
      "AUTH_CONFIGURATION_ERROR",
      "Configure AUTH_JWKS_URL or AUTH_JWKS_JSON",
    );
  }

  try {
    const cacheKey = `local:${env.AUTH_JWKS_JSON}`;
    const cached = verifierCache.get(cacheKey);
    if (cached) return cached;
    const verifier = createLocalJWKSet(jwksSchema.parse(JSON.parse(env.AUTH_JWKS_JSON)));
    verifierCache.set(cacheKey, verifier);
    return verifier;
  } catch {
    throw new AuthenticationError("AUTH_CONFIGURATION_ERROR", "AUTH_JWKS_JSON is invalid");
  }
}
