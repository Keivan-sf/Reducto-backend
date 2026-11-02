import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError } from "../../lib/http.js";
import type { ObjectStorage } from "../../lib/object-storage.js";
import type { AdminRepository, CleanupCounts } from "./admin.repository.js";

export type CleanupResult = CleanupCounts & { completedAt: string };
export const CLEANUP_EVENT = "messages.cleared";

export class AdminService {
	private running = false;

	constructor(
		private readonly repository: AdminRepository,
		private readonly storage: Pick<ObjectStorage, "deleteObject">,
		private readonly password: string | undefined,
		private readonly broadcast: (event: string, payload: CleanupResult) => void,
	) {}

	async cleanup(password: string): Promise<CleanupResult> {
		if (!this.password)
			throw new HttpError(503, "ADMIN_PASSWORD is not configured");
		const hash = (value: string) => createHash("sha256").update(value).digest();
		if (!timingSafeEqual(hash(password), hash(this.password)))
			throw new HttpError(401, "Invalid admin password");
		if (this.running) throw new HttpError(409, "Cleanup is already running");
		this.running = true;
		try {
			const counts = await this.repository.cleanup(async (keys) => {
				// Bound S3 requests; settle each group before rollback/retry on failure.
				for (let offset = 0; offset < keys.length; offset += 10) {
					const results = await Promise.allSettled(
						keys
							.slice(offset, offset + 10)
							.map((key) => this.storage.deleteObject(key)),
					);
					if (results.some((result) => result.status === "rejected"))
						throw new HttpError(
							502,
							"Attachment deletion failed; retry cleanup",
						);
				}
			});
			const result = { ...counts, completedAt: new Date().toISOString() };
			this.broadcast(CLEANUP_EVENT, result);
			return result;
		} finally {
			this.running = false;
		}
	}
}
