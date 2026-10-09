# Security policy

Gavel Live is a demo application, not a payment or identity platform. The auction API accepts
short-lived JWTs from a configured issuer and trusts the `role` claim for seller, bidder, and
viewer access. Deployments must use an issuer that controls role assignment and key rotation.

## Credential handling

- Never commit private JWKs, access tokens, `.dev.vars`, or Cloudflare credentials.
- Store deployed private keys as Worker secrets. Keep only public JWKS keys in Worker configuration.
- Treat demo and test tokens as credentials. They are stored in browser `sessionStorage` by the web
  client and are available to scripts running in that browser origin.
- Demo tokens are scoped to one auction and expire after 15 minutes. Keep `DEMO_MODE` disabled in
  production unless public demo-session issuance is an intentional feature.
- Do not use a development or staging signing key for production users.

The demo does not process payment or carry video. Do not use it to collect payment credentials or
to run real-money auctions.

## Reporting a vulnerability

Please do not report security vulnerabilities in public issues. Use the repository's private
vulnerability reporting feature on GitHub if it is enabled. Otherwise, contact the maintainer
privately through the contact information on the GitHub profile and include steps to reproduce,
affected versions, and the impact you observed.
