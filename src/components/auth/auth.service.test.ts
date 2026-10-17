import { expect, test } from "@jest/globals";
import { InMemoryAuthRepository } from "./auth.repository.js";
import { AuthService } from "./auth.service.js";

function createService() {
	return new AuthService(new InMemoryAuthRepository(), {
		accessTokenSecret: "access-secret-that-is-long-enough-for-tests",
		refreshTokenSecret: "refresh-secret-that-is-long-enough-for-tests",
		accessTokenLifetimeSeconds: 900,
		refreshTokenLifetimeSeconds: 3600,
	});
}

test("sign-up creates an account and produces a usable access token", async () => {
	const service = createService();
	const result = await service.signUp(
		"Ada@Example.com",
		"correct horse battery staple",
	);
	expect(result.user.email).toBe("ada@example.com");
	expect(service.verifyAccessToken(result.tokens.accessToken)).toBe(
		result.user.id,
	);
	expect(result.user.passwordHash).not.toBe("correct horse battery staple");
});

test("sign-in rejects invalid credentials", async () => {
	const service = createService();
	await service.signUp("ada@example.com", "correct horse battery staple");
	await expect(
		service.signIn("ada@example.com", "wrong password"),
	).rejects.toMatchObject({ status: 401 });
});

test("refresh rotates the refresh token and sign-out revokes it", async () => {
	const service = createService();
	const initial = await service.signUp(
		"ada@example.com",
		"correct horse battery staple",
	);
	const refreshed = await service.refresh(initial.tokens.refreshToken);
	expect(refreshed.refreshToken).not.toBe(initial.tokens.refreshToken);
	await expect(
		service.refresh(initial.tokens.refreshToken),
	).rejects.toMatchObject({ status: 401 });
	await service.signOut(refreshed.refreshToken);
	await expect(service.refresh(refreshed.refreshToken)).rejects.toMatchObject({
		status: 401,
	});
});
