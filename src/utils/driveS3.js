import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

// Same resolution order as the other Drive services: S3_REGION (ap-south-1
// on prod) wins over the SDK-global AWS_REGION (us-east-1).
const S3_DEFAULT_REGION = process.env.S3_REGION
  || process.env.AWS_S3_BUCKET_REGION
  || process.env.AWS_REGION
  || 'ap-south-1';
const S3_BUCKET = process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || 'zillit-drive';

const clients = {};

const getS3Client = (region) => {
  const r = region || S3_DEFAULT_REGION;
  if (!clients[r]) {
    clients[r] = new S3Client({
      region: r,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return clients[r];
};

// Where a Drive file's live content is stored.
const getFileS3Info = (file) => {
  const attachment = file?.attachments?.[0] || {};
  return {
    s3Key: file?.file_path || attachment.media || attachment.file_path || null,
    bucket: attachment.bucket || S3_BUCKET,
    region: attachment.region || S3_DEFAULT_REGION,
  };
};

// CopySource must be URL-encoded; keep the slashes between key segments.
const copySource = (bucket, key) => `${bucket}/${String(key).split('/').map(encodeURIComponent).join('/')}`;

const getObjectBuffer = async ({ bucket, key, region }) => {
  const response = await getS3Client(region).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await response.Body.transformToByteArray());
};

export {
  S3_DEFAULT_REGION,
  S3_BUCKET,
  getS3Client,
  getFileS3Info,
  copySource,
  getObjectBuffer,
};
