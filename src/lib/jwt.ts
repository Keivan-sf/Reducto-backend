import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http.js";

type JwtPayload = {
	sub: string;
	type: "access" | "refresh";
	exp: number;
	iat: number;
	jti?: string;
};

function encode(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(value: string, secret: string): string {
	return createHmac("sha256", secret).update(value).digest("base64url");
}

export function createToken(
	payload: Omit<JwtPayload, "iat" | "exp">,
	secret: string,
	lifetimeSeconds: number,
): string {
	const now = Math.floor(Date.now() / 1000);
	const header = encode({ alg: "HS256", typ: "JWT" });
	const body = encode({ ...payload, iat: now, exp: now + lifetimeSeconds });
	const unsigned = `${header}.${body}`;
	return `${unsigned}.${sign(unsigned, secret)}`;
}

export function verifyToken(
	token: string,
	secret: string,
	expectedType: JwtPayload["type"],
): JwtPayload {
	const parts = token.split(".");
	if (parts.length !== 3) throw new HttpError(401, "Invalid token");
	const [header, body, signature] = parts;
	const expected = Buffer.from(sign(`${header}.${body}`, secret));
	const actual = Buffer.from(signature);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
		throw new HttpError(401, "Invalid token");
	try {
		const payload = JSON.parse(
			Buffer.from(body, "base64url").toString("utf8"),
		) as JwtPayload;
		if (
			payload.type !== expectedType ||
			!payload.sub ||
			payload.exp <= Math.floor(Date.now() / 1000)
		)
			throw new Error();
		return payload;
	} catch {
		throw new HttpError(401, "Expired or invalid token");
	}
}
