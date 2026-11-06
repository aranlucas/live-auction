// Native jose APIs supply signing primitives, but no CLI enforces this auction subject/role/issuer/audience contract.
// Retained command covered by test/tooling/auth-cli.test.ts.
import { parseArgs } from "node:util";
import { z } from "zod";
import { issueToken } from "./auth-support";

const argumentsSchema = z.strictObject({
  subject: z.string().min(1),
  role: z.enum(["seller", "bidder", "viewer"]),
  issuer: z.string().url(),
  audience: z.string().min(1),
  privateJwkPath: z.string().min(1),
});

const { values } = parseArgs({
  args: process.argv.slice(2).filter((argument) => argument !== "--"),
  allowPositionals: false,
  options: {
    subject: { type: "string" },
    role: { type: "string" },
    issuer: { type: "string" },
    audience: { type: "string" },
    "private-jwk-path": { type: "string" },
  },
});

const input = argumentsSchema.parse({
  subject: values["subject"],
  role: values["role"],
  issuer: values["issuer"] ?? "https://cloudflare-live-auction.example",
  audience: values["audience"] ?? "cloudflare-live-auction",
  privateJwkPath: values["private-jwk-path"] ?? ".auction-auth-private.jwk",
});

process.stdout.write(
  (await issueToken(input.subject, input.role, {
    issuer: input.issuer,
    audience: input.audience,
    privateJwkPath: input.privateJwkPath,
  })) + "\n",
);
