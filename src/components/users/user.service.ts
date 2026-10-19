import { HttpError } from "../../lib/http.js";
import type { UserProfileRecord, UserRepository } from "./user.repository.js";

export interface AvatarUrls {
	getAvatarUrl(key: string): Promise<string>;
}

export class UserService {
	constructor(
		private readonly repository: UserRepository,
		private readonly avatars: AvatarUrls,
	) {}

	private async basicDetails(user: UserProfileRecord | undefined) {
		if (!user) throw new HttpError(404, "User not found");
		return {
			id: user.id,
			name: user.name,
			username: user.username,
			avatarUrl: user.avatarKey
				? await this.avatars.getAvatarUrl(user.avatarKey)
				: null,
		};
	}

	async getById(id: string) {
		return this.basicDetails(await this.repository.findById(id));
	}

	async getByUsername(username: string) {
		return this.basicDetails(
			await this.repository.findByUsername(username.toLowerCase()),
		);
	}
}
