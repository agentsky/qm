import { signedRequestHeaders } from "./source-auth-sign.ts";

export function signedHeaders(
  secret: string | undefined,
  method: string,
  pathWithQuery: string,
  rawBody = "",
  signatureTail = rawBody,
): Record<string, string> {
  return signedRequestHeaders(secret, method, pathWithQuery, signatureTail, { "content-type": "application/json" });
}
