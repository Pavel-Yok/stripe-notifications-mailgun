// src/utils/gcs.js
import { Storage } from "@google-cloud/storage";
const storage = new Storage();

export async function readGcsText(bucket, path) {
  // Accept both "gs://my-bucket" and "my-bucket"
  const name = String(bucket || "").replace(/^gs:\/\//, "").trim();
  if (!name) {
    throw new Error(`readGcsText: empty bucket (input="${bucket}")`);
  }
  if (!path) {
    throw new Error("readGcsText: empty path");
  }
  const file = storage.bucket(name).file(path);
  const [buf] = await file.download();
  return buf.toString("utf8");
}
