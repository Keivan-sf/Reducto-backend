import {
	DeleteObjectCommand,
	GetObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface ObjectStorage {
	putObject(input: {
		key: string;
		body: Buffer;
		contentType: string;
	}): Promise<void>;
	deleteObject(key: string): Promise<void>;
}

export type S3ObjectStorageConfig = {
	endpoint: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
};

export class S3ObjectStorage implements ObjectStorage {
	private readonly client: S3Client;

	constructor(private readonly config: S3ObjectStorageConfig) {
		this.client = new S3Client({
			endpoint: config.endpoint,
			region: "us-east-1",
			forcePathStyle: true,
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
			},
		});
	}

	async putObject(input: {
		key: string;
		body: Buffer;
		contentType: string;
	}): Promise<void> {
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.config.bucket,
				Key: input.key,
				Body: input.body,
				ContentType: input.contentType,
			}),
		);
	}

	async deleteObject(key: string): Promise<void> {
		await this.client.send(
			new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
		);
	}

	async getObject(key: string): Promise<Buffer> {
		const response = await this.client.send(
			new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
		);
		if (!response.Body) throw new Error("Stored attachment has no body");
		return Buffer.from(await response.Body.transformToByteArray());
	}

	async getAvatarUrl(key: string): Promise<string> {
		return getSignedUrl(
			this.client,
			new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
			{ expiresIn: 15 * 60 },
		);
	}

	async getThumbnailUrl(key: string): Promise<string> {
		return getSignedUrl(
			this.client,
			new GetObjectCommand({
				Bucket: this.config.bucket,
				Key: key,
				ResponseContentType: "image/jpeg",
				ResponseContentDisposition: "inline",
			}),
			{ expiresIn: 15 * 60 },
		);
	}

	async getPlaybackUrl(key: string): Promise<string> {
		return getSignedUrl(
			this.client,
			new GetObjectCommand({
				Bucket: this.config.bucket,
				Key: key,
				ResponseContentType: "video/mp4",
				ResponseContentDisposition: "inline",
			}),
			{ expiresIn: 15 * 60 },
		);
	}
}
