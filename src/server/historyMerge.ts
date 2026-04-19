export interface ReportSession {
  label: string;
  turns: number;
  wasteFactor: number;
  totalTokens: number;
  date: string;
  avgCacheRatio: number;
}

export interface ClauditorSession {
  label: string;
  turns: number;
  cacheRatio: number;
  cost: number;
  model: string;
  lastUpdated: string;
}

export interface SessionRow {
  label: string;
  date: string;
  turns: number;
  wasteFactor: number;
  totalTokens: number;
  cacheRatio: number;
  cost: number;
  model: string;
}

function projectNameFromReport(label: string): string {
  // "username/ProjectName" → "ProjectName"
  const parts = label.split("/");
  return parts[parts.length - 1].toLowerCase();
}

function projectNameFromSession(label: string): string {
  // "ProjectName (main)" → "projectname"
  return label.replace(/\s*\(.*\)$/, "").trim().toLowerCase();
}

export function mergeHistory(
  report: ReportSession[],
  sessions: ClauditorSession[],
): SessionRow[] {
  const sessionMap = new Map<string, ClauditorSession>();
  for (const s of sessions) {
    const key = `${projectNameFromSession(s.label)}|${s.turns}`;
    sessionMap.set(key, s);
  }

  return report
    .map((r): SessionRow => {
      const key = `${projectNameFromReport(r.label)}|${r.turns}`;
      const s = sessionMap.get(key);
      return {
        label: r.label,
        date: r.date,
        turns: r.turns,
        wasteFactor: r.wasteFactor ?? 1.0,
        totalTokens: r.totalTokens,
        cacheRatio: r.avgCacheRatio ?? s?.cacheRatio ?? 0,
        cost: s?.cost ?? 0,
        model: s?.model ?? "",
      };
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}
