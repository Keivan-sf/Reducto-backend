import { randomUUID } from "node:crypto";
import { HttpError } from "../../lib/http.js";
import { createToken, verifyToken } from "../../lib/jwt.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import type { AuthRepository, AuthUser } from "./auth.repository.js";
import { tokenHash } from "./auth.repository.js";

export type AuthConfig = {
	accessTokenSecret: string;
	refreshTokenSecret: string;
	accessTokenLifetimeSeconds: number;
	refreshTokenLifetimeSeconds: number;
};

export type TokenPair = {
	accessToken: string;
	refreshToken: string;
	tokenType: "Bearer";
	expiresIn: number;
};

export class AuthService {
	constructor(
		private readonly repository: AuthRepository,
		private readonly config: AuthConfig,
	) {}

	async signUp(
		email: string,
		password: string,
	): Promise<{ user: AuthUser; tokens: TokenPair }> {
		const normalizedEmail = email.trim().toLowerCase();
		if (await this.repository.findUserByEmail(normalizedEmail))
			throw new HttpError(409, "Email is already registered");
		const user = await this.repository.createUser(
			normalizedEmail,
			await hashPassword(password),
		);
		return { user, tokens: await this.issueTokens(user.id) };
	}

	async signIn(
		email: string,
		password: string,
	): Promise<{ user: AuthUser; tokens: TokenPair }> {
		const user = await this.repository.findUserByEmail(
			email.trim().toLowerCase(),
		);
		if (!user || !(await verifyPassword(password, user.passwordHash)))
			throw new HttpError(401, "Invalid email or password");
		return { user, tokens: await this.issueTokens(user.id) };
	}

	async refresh(refreshToken: string): Promise<TokenPair> {
		const payload = verifyToken(
			refreshToken,
			this.config.refreshTokenSecret,
			"refresh",
		);
		if (!payload.jti) throw new HttpError(401, "Invalid refresh token");
		const session = await this.repository.findSession(payload.jti);
		if (
			!session ||
			session.userId !== payload.sub ||
			session.tokenHash !== tokenHash(refreshToken) ||
			session.expiresAt <= new Date()
		) {
			throw new HttpError(401, "Refresh token is invalid or revoked");
		}
		await this.repository.deleteSession(session.id);
		return this.issueTokens(payload.sub);
	}

	async signOut(refreshToken: string): Promise<void> {
		try {
			const payload = verifyToken(
				refreshToken,
				this.config.refreshTokenSecret,
				"refresh",
			);
			if (payload.jti) await this.repository.deleteSession(payload.jti);
		} catch (error) {
			if (!(error instanceof HttpError)) throw error;
		}
	}

	verifyAccessToken(accessToken: string): string {
		return verifyToken(accessToken, this.config.accessTokenSecret, "access")
			.sub;
	}

	async getUser(userId: string): Promise<AuthUser> {
		const user = await this.repository.findUserById(userId);
		if (!user) throw new HttpError(401, "User no longer exists");
		return user;
	}

	private async issueTokens(userId: string): Promise<TokenPair> {
		const sessionId = randomUUID();
		const refreshToken = createToken(
			{ sub: userId, type: "refresh", jti: sessionId },
			this.config.refreshTokenSecret,
			this.config.refreshTokenLifetimeSeconds,
		);
		await this.repository.createSession({
			id: sessionId,
			userId,
			tokenHash: tokenHash(refreshToken),
			expiresAt: new Date(
				Date.now() + this.config.refreshTokenLifetimeSeconds * 1000,
			),
		});
		return {
			accessToken: createToken(
				{ sub: userId, type: "access" },
				this.config.accessTokenSecret,
				this.config.accessTokenLifetimeSeconds,
			),
			refreshToken,
			tokenType: "Bearer",
			expiresIn: this.config.accessTokenLifetimeSeconds,
		};
	}
}
