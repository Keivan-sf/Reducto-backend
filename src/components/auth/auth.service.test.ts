import { expect, test } from "@jest/globals";
import { InMemoryAuthRepository } from "./auth.repository.js";
import { signUpSchema } from "./auth.router.js";
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
		"Ada Lovelace",
		"Ada_Lovelace",
	);
	expect(result.user.email).toBe("ada@example.com");
	expect(result.user.name).toBe("Ada Lovelace");
	expect(result.user.username).toBe("ada_lovelace");
	expect(service.verifyAccessToken(result.tokens.accessToken)).toBe(
		result.user.id,
	);
	expect(result.user.passwordHash).not.toBe("correct horse battery staple");
});

test("sign-in rejects invalid credentials", async () => {
	const service = createService();
	await service.signUp(
		"ada@example.com",
		"correct horse battery staple",
		"Ada Lovelace",
	);
	await expect(
		service.signIn("ada@example.com", "wrong password"),
	).rejects.toMatchObject({ status: 401 });
});

test("refresh rotates the refresh token and sign-out revokes it", async () => {
	const service = createService();
	const initial = await service.signUp(
		"ada@example.com",
		"correct horse battery staple",
		"Ada Lovelace",
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

test("sign-up rejects usernames that differ only by case", async () => {
	const service = createService();
	await service.signUp(
		"ada@example.com",
		"correct horse battery staple",
		"Ada Lovelace",
		"Ada_Lovelace",
	);
	await expect(
		service.signUp(
			"grace@example.com",
			"correct horse battery staple",
			"Grace Hopper",
			"ada_lovelace",
		),
	).rejects.toMatchObject({ status: 409 });
});

test("sign-up usernames accept only English letters, numbers, and underscores", () => {
	const validInput = {
		email: "ada@example.com",
		password: "correct horse battery staple",
		name: "Ada Lovelace",
	};
	expect(
		signUpSchema.safeParse({ ...validInput, username: "Ada_123" }).success,
	).toBe(true);
	expect(
		signUpSchema.safeParse({ ...validInput, username: "ada-lovelace" }).success,
	).toBe(false);
	expect(
		signUpSchema.safeParse({ ...validInput, username: "آدا" }).success,
	).toBe(false);
});
