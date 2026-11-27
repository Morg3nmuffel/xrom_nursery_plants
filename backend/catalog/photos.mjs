import { ApiError, invalid } from '../validation.mjs';

export const photoTypes = ['image/jpeg', 'image/png', 'image/webp'];
export const photoMaxBytes = 5 * 1024 * 1024;
export const photoRequestLimit = Math.ceil(photoMaxBytes / 3) * 4 + 64 * 1024;
export const photoPath = /^\/plant-photos\/([a-f0-9]{32})$/;

const signatures = {
  'image/jpeg': (bytes) => bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/png': (bytes) => bytes.length >= 45 &&
    bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' &&
    bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND',
  'image/webp': (bytes) => bytes.length >= 20 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) + 8 === bytes.length &&
    bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16)),
};

export function readPlantPhoto(value) {
  if (value === undefined) return null;
  const header = typeof value === 'string' && /^data:(image\/(?:jpeg|png|webp));base64,/.exec(value);
  if (!header) invalid('Выберите фото в формате JPG, PNG или WebP.');
  const encoded = value.slice(header[0].length);
  const contentType = header[1];
  if (encoded.length > Math.ceil(photoMaxBytes / 3) * 4) {
    throw new ApiError(413, 'photo_too_large', 'Размер фото должен быть не больше 5 МБ.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > photoMaxBytes) {
    throw new ApiError(413, 'photo_too_large', 'Размер фото должен быть не больше 5 МБ.');
  }
  if (bytes.toString('base64') !== encoded || !signatures[contentType](bytes)) {
    invalid('Файл фото повреждён или его формат не совпадает с выбранным.');
  }
  return { contentType, bytes };
}
