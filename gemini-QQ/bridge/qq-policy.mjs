export const QZONE_TOOL_NAMES = ['qq_qzone_status', 'qq_post_qzone'].map(name => `mcp__qq__${name}`);
export const QQ_TOOL_NAMES = ['qq_status', 'qq_list_groups', 'qq_recent_messages', 'qq_send_message', 'qq_reply', 'qq_qzone_status', 'qq_post_qzone', 'qq_find_sticker', 'qq_send_sticker']
  .map((name) => `mcp__qq__${name}`);
// A harmless baseline tool must remain immediately available when older DSH histories
// introduce QQ tools through deferred tool additions. It only changes this session's TODOs.
export const CHAT_TOOL_NAMES = [...QQ_TOOL_NAMES, 'todo_write'];
export const FISH_CHAT_TOOL_NAMES = [...CHAT_TOOL_NAMES, 'growth_commit', 'her_recall', 'her_leave', 'bili_look', 'companion_remember', 'companion_recall'];

export function targetAllowed(cfg, type, id) {
  id = String(id);
  if (!/^\d{1,20}$/.test(id)) return false;
  if (type === 'group') return cfg.groupsEnabled === true
    && (cfg.allowGroups.length === 0 || cfg.allowGroups.includes(id));
  if (type === 'private') return cfg.ownerQq.includes(id) || cfg.allowUsers.includes(id);
  return false;
}

export function scopeAllows(cfg, scope, type, id) {
  if (!scope || !targetAllowed(cfg, type, id)) return false;
  return scope.access === 'owner' || (scope.type === type && scope.id === String(id));
}

export function accessFor(meta) {
  // A shared group history never gains local execution rights, even when owner speaks.
  return !meta.isGroup && meta.owner === true ? 'owner' : 'chat';
}
