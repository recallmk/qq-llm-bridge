import { deflateSync } from 'node:zlib';
import { randomInt } from 'node:crypto';

const digits = ['11111100011000110001100011000111111','00100011000010000100001000010001110',
  '11111000010000111111100001000011111','11111000010000111111000010000111111',
  '10001100011000111111000010000100001','11111100001000011111000010000111111',
  '11111100001000011111100011000111111','11111000010001000100010000100001000',
  '11111100011000111111100011000111111','11111100011000111111000010000111111'];
function crc32(bytes) {
  let value = 0xffffffff;
  for (const b of bytes) { value ^= b; for (let n = 0; n < 8; n++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([size, type, data, crc]);
}
/** Random visual facts never appear in the prompt, path, metadata or tool input. */
export function visionFixture() {
  const width = 560, height = 300, stride = width * 3 + 1;
  const raster = Buffer.alloc(height * stride, 255);
  for (let y = 0; y < height; y++) raster[y * stride] = 0;
  const paint = (x, y, w, h, rgb) => {
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      const i = row * stride + 1 + col * 3; for (let c = 0; c < 3; c++) raster[i + c] = rgb[c];
    }
  };
  const code = Array.from({ length: 4 }, () => randomInt(10)).join('');
  for (let n = 0; n < 4; n++) for (let bit = 0; bit < 35; bit++) if (digits[Number(code[n])][bit] === '1') {
    paint(25 + n * 135 + bit % 5 * 18, 20 + Math.floor(bit / 5) * 18, 18, 18, [0, 0, 0]);
  }
  const colors = [{ name: '红色', rgb: [235, 35, 35] }, { name: '绿色', rgb: [30, 185, 50] }, { name: '蓝色', rgb: [35, 70, 235] }];
  const shift = randomInt(3);
  for (let n = 0; n < 3; n++) paint(25 + n * 180, 195, 150, 80, colors[(n + shift) % 3].rgb);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raster)), chunk('IEND', Buffer.alloc(0))]);
  return { bytes, code, color: colors[shift].name, rightColor: colors[(shift + 2) % 3].name };
}
