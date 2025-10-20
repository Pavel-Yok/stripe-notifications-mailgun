// src/utils/gcs.js
import { Storage } from "@google-cloud/storage";

const storage = new Storage();

/**
 * Read a UTF-8 text file from GCS.
 * @param {string} bucketName - e.g. "yokweb-billing-001-email-assets" (NO "gs://")
 * @param {string} filePath   - e.g. "brands/yokweb.json"
 * @returns {Promise<string>}
 */
export async function readGcsText(storage, bucketName, filePath) {
  if (!bucketName) {
    throw new Error("GCS: bucketName is empty");
  }
  // be tolerant if someone sets env with gs://
  bucketName = bucketName.replace(/^gs:\/\//, "");

  if (!filePath) {
    throw new Error("GCS: filePath is empty");
  }

  const file = storage.bucket(bucketName).file(filePath);
  const [buf] = await file.download();
  return bomToUtf8(buf);
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
