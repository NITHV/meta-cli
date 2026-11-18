import { styleText } from 'node:util';
import type { AgentEvent } from './agents/types.ts';

export const dim = (s: string) => styleText('dim', s);
export const red = (s: string) => styleText('red', s);
export const green = (s: string) => styleText('green', s);
export const bold = (s: string) => styleText('bold', s);

export function printEvent(ev: AgentEvent, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(ev) + '\n');
    return;
  }
  switch (ev.kind) {
    case 'start':
      console.log(dim(`● started${ev.model ? ` (${ev.model})` : ''}`));
      break;
    case 'text':
      console.log(ev.text.trim());
      break;
    case 'tool': {
      const d = ev.detail.length > 100 ? ev.detail.slice(0, 97) + '...' : ev.detail;
      console.log(dim(`  → ${ev.name}${d ? ' ' + d : ''}`));
      break;
    }
    case 'tool_result':
      if (!ev.ok) console.log(red(`  ✗ ${ev.preview}`));
      break;
    case 'done': {
      const bits = [
        ev.turns != null ? `${ev.turns} turns` : '',
        ev.durationMs != null ? `${(ev.durationMs / 1000).toFixed(1)}s` : '',
      ].filter(Boolean);
      console.log(dim(`● ${ev.ok ? 'finished' : 'failed'}${bits.length ? ' · ' + bits.join(' · ') : ''}`));
      break;
    }
    case 'log':
      console.log(dim(ev.text));
      break;
  }
}

export function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
