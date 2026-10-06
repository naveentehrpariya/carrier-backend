const axios = require("axios");
const fs = require("fs");
const path = require("path");

/**
 * Store an uploaded file and return its public URL.
 *
 * Three backends, chosen by STORAGE_DRIVER (or inferred):
 *   s3     — AWS S3. Needs AWS_S3_BUCKET + AWS_REGION + AWS_ACCESS_KEY_ID +
 *            AWS_SECRET_ACCESS_KEY. Objects must be publicly readable through a
 *            bucket policy (ACLs are off on new buckets). AWS_S3_PUBLIC_URL may
 *            point at a CloudFront domain instead of the bucket URL.
 *   local  — the server's own disk, backend/uploads (or UPLOADS_DIR), served by
 *            index.js at /uploads. FILES_BASE_URL is the public URL the API is
 *            reached on (e.g. https://logistikore.com/api). Free, but it shares
 *            the disk with MongoDB — watch the space.
 *   bunny  — the original Bunny storage zone. Only when asked for explicitly:
 *            the account stopped accepting uploads.
 *
 * Default: s3 when a bucket is configured, otherwise local.
 * The return shape is unchanged for every caller; `false` still means "failed".
 * Files already stored keep their absolute URLs, so switching drivers never
 * breaks an existing document link.
 */

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, "..", "uploads");

function storageDriver() {
  const d = String(process.env.STORAGE_DRIVER || "").trim().toLowerCase();
  if (["s3", "local", "bunny"].includes(d)) return d;
  return process.env.AWS_S3_BUCKET ? "s3" : "local";
}

const safeName = (file) => {
  const original = String(file.originalname || "file").replace(/\s/g, "").replace(/[^A-Za-z0-9._-]/g, "_").slice(-120);
  return `${Date.now()}-${file.filename || Math.random().toString(36).slice(2)}-${original}`;
};

let s3Client = null;
function getS3() {
  if (!s3Client) {
    const { S3Client } = require("@aws-sdk/client-s3");
    s3Client = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
  }
  return s3Client;
}

async function uploadS3(file, key) {
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  const bucket = process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_REGION || "us-east-1";
  const prefix = String(process.env.AWS_S3_PREFIX || "uploads").replace(/^\/+|\/+$/g, "");
  const objectKey = prefix ? `${prefix}/${key}` : key;
  await getS3().send(new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    Body: fs.createReadStream(file.path),
    ContentType: file.mimetype || "application/octet-stream",
    ContentLength: file.size || undefined,
  }));
  const base = (process.env.AWS_S3_PUBLIC_URL || `https://${bucket}.s3.${region}.amazonaws.com`).replace(/\/+$/, "");
  return `${base}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
}

async function uploadLocal(file, key) {
  await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.promises.copyFile(file.path, path.join(UPLOADS_DIR, key));
  const base = (process.env.FILES_BASE_URL || `http://localhost:${process.env.PORT || 5004}`).replace(/\/+$/, "");
  return `${base}/uploads/${encodeURIComponent(key)}`;
}

async function uploadBunny(file, key) {
  const url = `https://storage.bunnycdn.com/${process.env.BUNNY_STORAGE_ZONE}/${key}`;
  const response = await axios.put(url, fs.createReadStream(file.path), {
    headers: { AccessKey: process.env.BUNNY_API_KEY, "Content-Type": file.mimetype },
  });
  if (response.status !== 201 && response.status !== 200) throw new Error(`Bunny upload failed with status ${response.status}`);
  return `https://capitallogisticmanagement.b-cdn.net/${key}`;
}

const fileupload = async (file) => {
  const driver = storageDriver();
  try {
    const key = safeName(file);
    const url = driver === "s3" ? await uploadS3(file, key)
      : driver === "bunny" ? await uploadBunny(file, key)
        : await uploadLocal(file, key);
    return {
      message: "File uploaded successfully",
      mime: file.mimetype,
      filename: key,
      url,
      file,
      size: file.size,
      storage: driver,
    };
  } catch (error) {
    console.error(`Upload error (${driver}): ${error?.message || error}`);
    return false;
  } finally {
    // Clean up the temporary file after attempting upload
    if (file && file.path) {
      fs.unlink(file.path, (err) => {
        if (err) console.error("Error deleting temporary file:", err.message);
      });
    }
  }
};

module.exports = fileupload;
module.exports.storageDriver = storageDriver;
module.exports.UPLOADS_DIR = UPLOADS_DIR;
