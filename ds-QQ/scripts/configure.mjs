import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (/^C:[\\/]/i.test(fs.realpathSync(root))) throw new Error('C 盘只读，请把项目放在其他盘');
for (const dir of ['.tmp', 'work', 'qq-bridge/memory', 'qq-bridge/fish-data', 'qq-bridge/image-cache', 'qq-bridge/stickers']) fs.mkdirSync(path.join(root, dir), { recursive: true });
const configFile = path.join(root, 'qq-bridge/config.json');
const runtimePatch = path.join(root, 'qq-bridge/qq.runtime.patch.yml');
let patch = fs.readFileSync(path.join(root, 'qq-bridge/qq.patch.yml'), 'utf8');
for (const [key, value] of Object.entries({
  __QQ_BRIDGE_SERVER_URL__: pathToFileURL(path.join(root, 'qq-bridge/dsh-qq-server.js')).href,
  __QQ_BRIDGE_NODE__: path.join(root, 'runtime/node/node.exe'),
  __QQ_BRIDGE_MCP__: path.join(root, 'qq-bridge/mcp-qq.mjs'),
})) patch = patch.replaceAll(key, value.replaceAll("'", "''"));
fs.writeFileSync(runtimePatch, patch);
const config = JSON.parse(fs.readFileSync(fs.existsSync(configFile) ? configFile : path.join(root, 'qq-bridge/config.example.json'), 'utf8').replace(/^\uFEFF/, ''));
Object.assign(config, {
  dshBin: path.join(root, 'DeepSeek-Harness/resources/runtime/cli/bin/dsh.cmd'),
  patchFile: runtimePatch,
  workspace: path.join(root, 'work'), dshHome: path.join(root, '.dsh'), memoryDir: path.join(root, 'qq-bridge/memory'),
});
for (const [name, dir] of [['fish', 'fish-data'], ['stickers', 'stickers'], ['vision', 'image-cache']]) {
  config[name] ??= {};
  config[name][name === 'stickers' ? 'dir' : 'root'] = path.join(root, 'qq-bridge', dir);
}
config.vision.localRoots = ['napcat', 'data/qq-user', 'QQ/data'].map(dir => path.join(root, dir));
fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
console.log('配置路径已更新；已有账号、额度、记忆设置保持不变。新部署请编辑 qq-bridge/config.json 并配置 NapCat 与 DSH 登录。');
