import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const projectPath = (...parts) => path.join(PROJECT_ROOT, ...parts);
export const projectUrl = (...parts) => new URL(parts.join('/'), new URL('../', import.meta.url)).href;
