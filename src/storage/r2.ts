import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { R2Config } from "../config.js";

/**
 * Mirrors CodedByKay.ArtShow.CLI/Storage/R2Client.cs. The .NET SDK needed two extra
 * request-level flags (DisablePayloadSigning / DisableDefaultChecksumValidation) to stop it
 * sending a chunked-with-trailing-checksum upload R2 rejects
 * (STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER not implemented) — see CLI AGENTS.md "Known
 * gotchas". The JS SDK v3's equivalent fix is these two client-level checksum settings (verified
 * during the Phase 0 spike, see working-on/mcp-rebuild-plan.md); there's no per-request flag
 * needed here.
 */
export function createR2Client(r2: R2Config): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: r2.serviceUrl,
    forcePathStyle: true,
    credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export async function uploadObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

export async function deleteObjects(client: S3Client, bucket: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  // S3's DeleteObjects API caps a single request at 1000 keys — chunk defensively even though the
  // catalog is nowhere near that size today.
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await client.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: chunk.map((Key) => ({ Key })) } }),
    );
  }
}

export async function objectExists(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "NotFound" || name === "NoSuchKey") return false;
    throw err;
  }
}

/** Lists every object key currently in the bucket (paginated) — mirrors R2Client.cs
 * ListAllObjectsAsync, used by check_sync and prune_orphaned_r2_objects. */
export async function listAllObjects(client: S3Client, bucket: string): Promise<Map<string, number>> {
  const objects = new Map<string, number>();
  let continuationToken: string | undefined;
  do {
    const response = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
    );
    for (const obj of response.Contents ?? []) {
      if (obj.Key) objects.set(obj.Key, obj.Size ?? 0);
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

export interface UrlCheckResult {
  url: string;
  ok: boolean;
  status: number | null;
  error?: string;
}

/** HEAD-checks a public URL (kaysartshow.fyi, not the R2 API) — this is how add_artworks confirms
 * an upload is actually live and cacheable at the CDN before deleting the local source file, and
 * how check_sync's optional verifyUrls works. */
export async function headPublicUrl(url: string, timeoutMs = 10_000): Promise<UrlCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "HEAD", signal: controller.signal });
    return { url, ok: response.ok, status: response.status };
  } catch (err) {
    return { url, ok: false, status: null, error: (err as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}
