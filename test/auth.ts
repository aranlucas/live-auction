import { importJWK, SignJWT } from "jose";

const privateJwk = {
  kty: "EC",
  x: "IYqpUjFfCd9FMDnpzRlIx0tTSRpbI7m7-q-hdmbpOc8",
  y: "uP6hmtNlUIjz8wCDxZe0-T4gDJn7Oh7cZa_kYgKMlYU",
  crv: "P-256",
  d: "n-2hnjyEEPICbvTma4YoJeSnht8wo5zdkXFtTIv8-nQ",
  kid: "test-key",
  alg: "ES256",
};

export async function tokenFor(
  subject: string,
  role: "seller" | "bidder" | "viewer",
  overrides?: { issuer?: string; expiresAt?: number; auctionId?: string },
): Promise<string> {
  const key = await importJWK(privateJwk, "ES256");
  const token = new SignJWT({ role, auctionId: overrides?.auctionId })
    .setProtectedHeader({ alg: "ES256", kid: privateJwk.kid })
    .setSubject(subject)
    .setIssuer(overrides?.issuer ?? "https://auction.test")
    .setAudience("live-auction-test")
    .setIssuedAt();
  if (overrides?.expiresAt !== undefined) token.setExpirationTime(overrides.expiresAt);
  else token.setExpirationTime("15m");
  return token.sign(key);
}

export async function actorHeaders(
  subject: string,
  role: "seller" | "bidder" | "viewer",
  idempotencyKey?: string,
): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await tokenFor(subject, role)}`,
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  };
}

export async function websocketProtocols(
  subject: string,
  role: "seller" | "bidder" | "viewer",
): Promise<string> {
  return `auction.v1, auth.${await tokenFor(subject, role)}`;
}
