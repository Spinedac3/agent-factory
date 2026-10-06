import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

export interface Person {
  id: number;
  email: string;
  scopes: string[];
}

export type VerifyPerson = (token: string) => Promise<Person | null>;

/**
 * Builds the check of a session the assistant signed, with the keys it publishes
 *
 * @param   keys    The assistant's public keys
 * @param   issuer  Who must have signed
 *
 * @return  A check that gives the person, or null for a token that is not a valid session
 */
export function personVerifier(keys: JWTVerifyGetKey, issuer: string): VerifyPerson {
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, keys, { issuer, algorithms: ["RS256"] });
      const id = Number(payload.sub);
      if (!Number.isInteger(id) || id <= 0) {
        return null;
      }

      return {
        id,
        email: typeof payload.email === "string" ? payload.email : "",
        scopes: Array.isArray(payload.scopes)
          ? payload.scopes.filter((scope): scope is string => typeof scope === "string")
          : [],
      };
    } catch {
      return null;
    }
  };
}

/**
 * Reads the assistant's public keys from its JWKS, fetched again when it rotates them
 *
 * @param   assistantUrl  The assistant's address
 *
 * @return  The keys to verify with
 */
export function assistantKeys(assistantUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL("/.well-known/jwks.json", assistantUrl));
}
