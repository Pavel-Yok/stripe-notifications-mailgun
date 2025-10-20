// src/utils/gcs.js
import { Storage } from "@google-cloud/storage";

const storage = new Storage();

/**
 * Read a UTF-8 text file from GCS.
 * @param {string} bucketName - e.g. "yokweb-billing-001-email-assets" (NO "gs://")
 * @param {string} filePath   - e.g. "brands/yokweb.json"
 * @returns {Promise<string>}
 */
export async function readGcsText(bucketName, filePath) {
  if (!bucketName || !filePath) {
    throw new Error(
      `readGcsText: missing bucketName or filePath (bucket="${bucketName}", path="${filePath}")`
    );
  }
  const file = storage.bucket(bucketName).file(filePath);
  const [buf] = await file.download();
  let text = buf.toString("utf8");
  // strip BOM if present
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/**
 * Same as readGcsText but returns null on 404 and logs other errors.
 */
export async function readOptionalText(bucketName, filePath) {
  try {
    return await readGcsText(bucketName, filePath);
  } catch (e) {
    if (e?.code === 404) return null;
    console.warn(
      `[gcs] readOptionalText failed for ${bucketName}/${filePath}:`,
      e?.message || e
    );
    return null;
  }
}
