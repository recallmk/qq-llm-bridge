export function localParts(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(p => [p.type, p.value]));
  const day = p.year + '-' + p.month + '-' + p.day;
  return { day, time: p.hour + ':' + p.minute, weekday: new Date(day + 'T12:00:00Z').getUTCDay() || 7 };
}
export function weekOf(day) { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() || 7) + 1); return d.toISOString().slice(0, 10); }
export const inWindow = (time, [start, end]) => start <= end ? time >= start && time < end : time >= start || time < end;
export function dayOffset(day, offset) { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); }
export function nextSlot(now, timeZone, time, weekday = null) {
  const current = localParts(now, timeZone);
  for (let n = 0; n < 8; n++) {
    const day = dayOffset(current.day, n), w = new Date(day + 'T12:00:00Z').getUTCDay() || 7;
    if ((!weekday || w === weekday) && (n > 0 || current.time < time)) return { day, time, timeZone };
  }
}
