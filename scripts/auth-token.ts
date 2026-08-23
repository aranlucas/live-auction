import { z } from "zod";
import { issueToken } from "./auth-support";

const argumentsSchema = z.strictObject({
  subject: z.string().min(1),
  role: z.enum(["seller", "bidder", "viewer"]),
  issuer: z.string().url(),
  audience: z.string().min(1),
  privateJwkPath: z.string().min(1),
});

const values = new Map<string, string>();
const cliArguments = process.argv.slice(2).filter((argument) => argument !== "--");
for (let index = 0; index < cliArguments.length; index += 2) {
  const key = cliArguments[index];
  const value = cliArguments[index + 1];
  if (!key?.startsWith("--") || value === undefined) {
    throw new Error(
      "Usage: pnpm auth:token -- --subject <id> --role <role> [--issuer <url>] [--audience <aud>]",
    );
  }
  values.set(key.slice(2), value);
}

const input = argumentsSchema.parse({
  subject: values.get("subject"),
  role: values.get("role"),
  issuer: values.get("issuer") ?? "https://cloudflare-live-auction.example",
  audience: values.get("audience") ?? "cloudflare-live-auction",
  privateJwkPath: values.get("private-jwk-path") ?? ".auction-auth-private.jwk",
});

console.log(
  await issueToken(input.subject, input.role, {
    issuer: input.issuer,
    audience: input.audience,
    privateJwkPath: input.privateJwkPath,
  }),
);
