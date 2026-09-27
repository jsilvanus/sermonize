import { jwtVerify } from 'jose';

export async function verifyBearerToken(
  token: string,
  secret: Uint8Array,
  issuer: string,
  resource: string,
) {
  const { payload } = await jwtVerify(token, secret, {
    algorithms: ['HS256'],
    issuer,
    audience: resource,
  });
  return payload;
}
