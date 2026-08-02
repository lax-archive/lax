export interface ProfileSpan {
  name: string;
  ms: number;
}

export function formatProfile(spans: ProfileSpan[], totalMs: number): string {
  const total = totalMs || 1;
  const lines = ["== profile =="];
  lines.push(`${"total".padEnd(36)}${formatMs(totalMs).padStart(8)}  100%`);
  for (const span of spans) {
    const percent = ((span.ms / total) * 100).toFixed(0).padStart(3);
    lines.push(`${(`  ${span.name}`).padEnd(36)}${formatMs(span.ms).padStart(8)}  ${percent}%`);
  }
  return lines.join("\n");
}

function formatMs(ms: number): string {
  if (ms >= 10_000) return `${(ms / 1_000).toFixed(0)}s`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms.toFixed(0)}ms`;
}
