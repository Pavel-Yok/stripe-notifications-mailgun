import { Storage } from '@google-cloud/storage';

const storage = new Storage();

/**
 * Read a GCS text file given a URL like: gs://bucket/path/to/file
 * Returns UTF-8 string.
 */
export async function readGcsText(gcsUrl) {
  const [, , bucketName, ...rest] = gcsUrl.split('/');
  const filePath = rest.join('/');
  const [buf] = await storage.bucket(bucketName).file(filePath).download();
  return buf.toString('utf8');
}
