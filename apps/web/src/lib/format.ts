import { decodeJwt } from "jose";
import { z } from "zod";

const identitySchema = z.object({ sub: z.string().optional() });

export function currency(cents: number | null, code = "USD"): string {
  if (cents === null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export function tokenSubject(token: string): string {
  if (!token) return "Token needed";
  try {
    return identitySchema.parse(decodeJwt(token)).sub ?? "Authenticated";
  } catch {
    return "Invalid token";
  }
}

export function compactTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}
