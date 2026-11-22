import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ResolvedConfig } from '../config/load.js';
import { fail } from '../errors/error.js';
import { sha256 } from '../ids.js';
import type {
  AbortMultipartInput,
  CompleteMultipartInput,
  MultipartInit,
  MultipartSession,
  ObjectMetadata,
  PutObjectInput,
  SignDownloadInput,
  SignedUrl,
  SignPartInput,
  StorageCapabilities,
  StorageDriver,
  StoredObject,
} from '../types/index.js';

type S3Settings = ResolvedConfig['storage']['s3'];

export function createS3Storage(settings: S3Settings): StorageDriver {
  const client = new S3Client({
    region: settings.region,
    endpoint: settings.endpoint,
    forcePathStyle: settings.forcePathStyle,
    credentials: settings.accessKeyId
      ? {
          accessKeyId: settings.accessKeyId,
          secretAccessKey: settings.secretAccessKey ?? '',
          ...(settings.sessionToken
            ? { sessionToken: settings.sessionToken }
            : {}),
        }
      : undefined,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const bucket = settings.bucket;

  return {
    capabilities(): StorageCapabilities {
      return {
        driver: 's3',
        multipart: true,
        presignedUpload: true,
        presignedDownload: true,
        rangeReads: true,
      };
    },
    async putObject(input: PutObjectInput): Promise<StoredObject> {
      const body =
        input.body instanceof Uint8Array
          ? input.body
          : await collect(input.body);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: input.key,
          Body: body,
          ContentType: input.contentType,
        }),
      );
      return {
        key: input.key,
        bytes: body.byteLength,
        etag: sha256(body),
        checksum: sha256(body),
      };
    },
    async getObject(key: string): Promise<ReadableStream<Uint8Array>> {
      const result = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      if (!result.Body) throw fail('STORAGE_UNAVAILABLE');
      return result.Body.transformToWebStream() as ReadableStream<Uint8Array>;
    },
    async headObject(key: string): Promise<ObjectMetadata | null> {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return {
          key,
          bytes: result.ContentLength ?? 0,
          etag: result.ETag ?? null,
          contentType: result.ContentType ?? null,
        };
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw fail('STORAGE_UNAVAILABLE', {
          message: 'Could not read the object head.',
        });
      }
    },
    async deleteObject(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async createMultipartUpload(
      input: MultipartInit,
    ): Promise<MultipartSession> {
      const result = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: input.key,
          ContentType: input.contentType,
        }),
      );
      if (!result.UploadId)
        throw fail('STORAGE_UNAVAILABLE', {
          message: 'S3 did not return an upload id.',
        });
      return { key: input.key, uploadId: result.UploadId };
    },
    async signUploadPart(input: SignPartInput): Promise<SignedUrl> {
      const url = await getSignedUrl(
        client,
        new UploadPartCommand({
          Bucket: bucket,
          Key: input.key,
          UploadId: input.uploadId,
          PartNumber: input.partNumber,
        }),
        { expiresIn: input.expiresInSeconds },
      );
      return {
        url,
        headers: {},
        expiresAt: new Date(
          Date.now() + input.expiresInSeconds * 1000,
        ).toISOString(),
      };
    },
    async completeMultipartUpload(
      input: CompleteMultipartInput,
    ): Promise<StoredObject> {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: input.key,
          UploadId: input.uploadId,
          MultipartUpload: {
            Parts: input.parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
      const head = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: input.key }),
      );
      return {
        key: input.key,
        bytes: head.ContentLength ?? 0,
        etag: head.ETag ?? '',
        checksum: null,
      };
    },
    async abortMultipartUpload(input: AbortMultipartInput): Promise<void> {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: input.key,
          UploadId: input.uploadId,
        }),
      );
    },
    async signDownload(input: SignDownloadInput): Promise<SignedUrl> {
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: input.key,
          ResponseContentType: input.contentType,
          ...(input.fileName
            ? {
                ResponseContentDisposition: `attachment; filename="${input.fileName}"`,
              }
            : {}),
        }),
        { expiresIn: input.expiresInSeconds },
      );
      return {
        url,
        headers: {},
        expiresAt: new Date(
          Date.now() + input.expiresInSeconds * 1000,
        ).toISOString(),
      };
    },
  };
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function statusOf(error: unknown): number | undefined {
  if (error && typeof error === 'object' && '$metadata' in error) {
    const metadata = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata;
    return metadata?.httpStatusCode;
  }
  return undefined;
}
