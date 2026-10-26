import { expect, jest, test } from "@jest/globals";
import { PresenceService } from "./presence.js";

function setup() {
	let time = Date.parse("2026-10-26T00:00:00Z");
	const saved = new Map<string, number>();
	const repository = {
		saveLastSeen: jest.fn(
			async (entries: ReadonlyArray<readonly [string, number]>) => {
				for (const [id, timestamp] of entries) saved.set(id, timestamp);
			},
		),
		findConversationPeerIds: jest.fn(async (_id: string) => ["peer"]),
	};
	const notifications = { publish: jest.fn() };
	const presence = new PresenceService(repository, notifications, () => time);
	return {
		presence,
		repository,
		notifications,
		saved,
		advance: (ms: number) => {
			time += ms;
		},
		now: () => time,
	};
}

test("heartbeats do no I/O; scans save the latest timestamp and notify only transitions", async () => {
	const { presence, repository, notifications, saved, advance, now } = setup();
	presence.heartbeat("alice");
	advance(10_000);
	presence.heartbeat("alice");
	expect(repository.saveLastSeen).not.toHaveBeenCalled();
	expect(notifications.publish).not.toHaveBeenCalled();
	const lastSeen = now();
	await presence.tick();
	expect(saved.get("alice")).toBe(lastSeen);
	expect(notifications.publish).toHaveBeenLastCalledWith(
		["peer"],
		"user.presence",
		{
			userId: "alice",
			online: true,
			last_seen: new Date(lastSeen).toISOString(),
		},
	);
	advance(60_000);
	await presence.tick();
	expect(notifications.publish).toHaveBeenCalledTimes(1);
	advance(1);
	await presence.tick();
	expect(notifications.publish).toHaveBeenLastCalledWith(
		["peer"],
		"user.presence",
		{
			userId: "alice",
			online: false,
			last_seen: new Date(lastSeen).toISOString(),
		},
	);
	expect(saved.get("alice")).toBe(lastSeen);
	const writes = repository.saveLastSeen.mock.calls.length;
	await presence.tick();
	expect(repository.saveLastSeen).toHaveBeenCalledTimes(writes);
	expect(notifications.publish).toHaveBeenCalledTimes(2);
	presence.heartbeat("alice");
	await presence.tick();
	expect(notifications.publish).toHaveBeenCalledTimes(3);
	expect(notifications.publish).toHaveBeenLastCalledWith(
		["peer"],
		"user.presence",
		{
			userId: "alice",
			online: true,
			last_seen: new Date(now()).toISOString(),
		},
	);
});

test("expired unannounced users are saved and evicted without a false online event", async () => {
	const { presence, advance, saved, repository, notifications } = setup();
	presence.heartbeat("alice");
	advance(60_001);
	await presence.tick();
	expect(saved.has("alice")).toBe(true);
	expect(notifications.publish).not.toHaveBeenCalled();
	await presence.tick();
	expect(repository.saveLastSeen).toHaveBeenCalledTimes(1);
});

test("failed writes and recipient lookups are retried without losing timestamps", async () => {
	const { presence, repository, notifications, saved, advance, now } = setup();
	presence.heartbeat("alice");
	repository.saveLastSeen.mockRejectedValueOnce(
		new Error("database unavailable"),
	);
	await expect(presence.tick()).rejects.toThrow("database unavailable");
	expect(notifications.publish).not.toHaveBeenCalled();
	await presence.tick();
	advance(60_001);
	repository.findConversationPeerIds.mockRejectedValueOnce(
		new Error("lookup failed"),
	);
	await expect(presence.tick()).rejects.toThrow("lookup failed");
	expect(notifications.publish).toHaveBeenCalledTimes(1);
	await presence.tick();
	expect(notifications.publish).toHaveBeenCalledTimes(2);
	expect(saved.get("alice")).toBe(now() - 60_001);
});

test("overlapping scans are skipped and a heartbeat during persistence survives", async () => {
	const { presence, repository, saved, advance, now } = setup();
	presence.heartbeat("alice");
	await presence.tick();
	advance(60_001);
	let finish!: () => void;
	repository.saveLastSeen.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const scan = presence.tick();
	await presence.tick();
	expect(repository.saveLastSeen).toHaveBeenCalledTimes(2);
	presence.heartbeat("alice");
	finish();
	await scan;
	await presence.tick();
	expect(saved.get("alice")).toBe(now());
});

test("a heartbeat during a recipient lookup cancels the stale offline transition", async () => {
	const { presence, repository, notifications, advance } = setup();
	presence.heartbeat("alice");
	await presence.tick();
	advance(60_001);
	repository.findConversationPeerIds.mockImplementationOnce(async () => {
		presence.heartbeat("alice");
		return ["peer"];
	});
	await presence.tick();
	expect(notifications.publish).toHaveBeenCalledTimes(1);
});

test("presence reads use unflushed heartbeats, expire immediately, and retain saved history after eviction", async () => {
	const { presence, repository, notifications, advance, now } = setup();
	const history = new Date(now() - 100_000);
	expect(presence.getPresence("alice")).toEqual({
		online: false,
		last_seen: null,
	});
	expect(presence.getPresence("alice", history)).toEqual({
		online: false,
		last_seen: history.toISOString(),
	});
	presence.heartbeat("alice");
	const lastSeen = now();
	expect(presence.getPresence("alice", history)).toEqual({
		online: true,
		last_seen: new Date(lastSeen).toISOString(),
	});
	expect(repository.saveLastSeen).not.toHaveBeenCalled();
	expect(notifications.publish).not.toHaveBeenCalled();
	advance(60_000);
	expect(presence.getPresence("alice").online).toBe(true);
	advance(1);
	expect(presence.getPresence("alice")).toEqual({
		online: false,
		last_seen: new Date(lastSeen).toISOString(),
	});
	await presence.tick();
	expect(presence.getPresence("alice", new Date(lastSeen))).toEqual({
		online: false,
		last_seen: new Date(lastSeen).toISOString(),
	});
});

test("presence reads preserve a newer database timestamp and do not infer online from history", () => {
	const { presence, now } = setup();
	const saved = new Date(now() + 1_000);
	expect(presence.getPresence("alice", saved)).toEqual({
		online: false,
		last_seen: saved.toISOString(),
	});
	presence.heartbeat("alice");
	expect(presence.getPresence("alice", saved)).toEqual({
		online: true,
		last_seen: saved.toISOString(),
	});
	expect(presence.getPresence("unknown", new Date(0))).toEqual({
		online: false,
		last_seen: "1970-01-01T00:00:00.000Z",
	});
});
