import { createHash, randomBytes } from "node:crypto";

/** RFC 7636: a random verifier and its S256 challenge. */
export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function randomState() {
  return randomBytes(24).toString("base64url");
}
