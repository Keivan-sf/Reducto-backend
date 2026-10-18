export interface Notifications {
	publish(userIds: string[], event: string, payload: unknown): void;
}
