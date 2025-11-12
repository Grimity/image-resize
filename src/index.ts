import { CloudFrontRequestEvent, CloudFrontRequestResult } from 'aws-lambda';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-northeast-2',
});
const BUCKET_NAME = 'grimity-image-prod';
const ALLOWED_SIZES = [300, 600, 1200];

export const handler = async (
  event: CloudFrontRequestEvent
): Promise<CloudFrontRequestResult> => {
  const request = event.Records[0]?.cf.request;
  if (!request) return null;

  const { uri, querystring } = request;
  if (uri.startsWith('/resized')) {
    return request; // 이미 리사이즈된 이미지 요청이면 무시
  }

  const params = new URLSearchParams(querystring);
  const sizeParam = params.get('s');
  console.log('Requested size:', sizeParam);

  // 쿼리스트링이 없으면 원본 이미지 그대로 반환
  if (!sizeParam) {
    return request;
  }

  // 허용된 사이즈만 처리
  const requestedSize = parseInt(sizeParam);
  if (!ALLOWED_SIZES.includes(requestedSize)) {
    console.log('Requested size is not allowed:', requestedSize);
    return request; // 허용되지 않은 사이즈면 원본 반환
  }

  try {
    const originalKey = uri.startsWith('/') ? uri.slice(1) : uri;
    const resizedKey = `resized/${requestedSize}/${originalKey}`;
    console.log('Resized image key:', resizedKey);

    // 1. 리사이징된 이미지가 S3에 존재하는지 확인
    const resizedExists = await checkS3ObjectExists(resizedKey);

    if (resizedExists) {
      // 리사이징된 이미지가 이미 존재하면 해당 경로로 변경
      request.uri = `/${resizedKey}`;
      return request;
    }

    const originalImage = await getS3Object(originalKey);

    if (!originalImage) {
      return request; // 원본도 없으면 그냥 원본 경로로 반환 (404 처리)
    }

    // 3. 이미지 리사이징
    const resizedImage = await resizeImage(originalImage, requestedSize);

    // 4. 리사이징된 이미지를 S3에 저장
    await putS3Object(
      resizedKey,
      resizedImage.buffer,
      resizedImage.contentType
    );

    // 5. 리사이징된 이미지 경로로 요청 변경
    request.uri = `/${resizedKey}`;
    return request;
  } catch (error) {
    console.error('Error processing image:', error);
    // 에러 발생 시 원본 이미지 반환
    console.log('Error', error);
    return request;
  }
};

async function checkS3ObjectExists(key: string): Promise<boolean> {
  try {
    await s3Client.send(
      new HeadObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
      })
    );
    return true;
  } catch (error: any) {
    if (error.name === 'NotFound') {
      return false;
    }
    throw error;
  }
}

async function getS3Object(key: string): Promise<Buffer | null> {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });
    const response = await s3Client.send(command);

    if (!response.Body) {
      return null;
    }

    // Stream을 Buffer로 변환
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as any) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error: any) {
    if (error.name === 'NoSuchKey') {
      return null;
    }
    throw error;
  }
}

async function putS3Object(
  key: string,
  buffer: Buffer,
  contentType: string
): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000', // 1년 캐싱
    })
  );
}

async function resizeImage(
  imageBuffer: Buffer,
  targetSize: number
): Promise<{ buffer: Buffer; contentType: string }> {
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error('Unable to get image dimensions');
  }

  // 짧은 변 찾기
  const shortSide = Math.min(metadata.width, metadata.height);

  // 비율 계산
  const ratio = targetSize / shortSide;

  // 새로운 크기 계산
  const newWidth = Math.round(metadata.width * ratio);
  const newHeight = Math.round(metadata.height * ratio);

  // 리사이징
  const resizedBuffer = await image
    .resize(newWidth, newHeight, {
      fit: 'inside', // 비율 유지하면서 리사이징
      withoutEnlargement: true, // 원본보다 크게 만들지 않음
    })
    .toBuffer();

  // Content-Type 결정
  let contentType = 'image/jpeg';
  if (metadata.format === 'png') {
    contentType = 'image/png';
  } else if (metadata.format === 'webp') {
    contentType = 'image/webp';
  } else if (metadata.format === 'gif') {
    contentType = 'image/gif';
  }

  return {
    buffer: resizedBuffer,
    contentType,
  };
}
