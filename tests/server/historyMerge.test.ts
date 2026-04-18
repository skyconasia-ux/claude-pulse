import { describe, it, expect } from "vitest";
import { mergeHistory, ReportSession, ClauditorSession } from "../../src/server/historyMerge";

const report: ReportSession[] = [
  { label: "quick/Alpha", turns: 50, wasteFactor: 2.5, totalTokens: 500_000, date: "2026-04-18T10:00:00Z", avgCacheRatio: 0.95 },
  { label: "quick/Beta",  turns: 10, wasteFactor: 1.2, totalTokens: 100_000, date: "2026-04-17T10:00:00Z", avgCacheRatio: 0.98 },
];

const sessions: ClauditorSession[] = [
  { label: "Alpha (main)", turns: 50, cacheRatio: 0.94, cost: 5.50, model: "claude-sonnet-4-6", lastUpdated: "2026-04-18T10:00:00Z" },
  { label: "Beta (master)", turns: 10, cacheRatio: 0.97, cost: 1.20, model: "claude-haiku-4-5", lastUpdated: "2026-04-17T10:00:00Z" },
];

describe("mergeHistory", () => {
  it("merges cost and model from sessions by projectName+turns", () => {
    const rows = mergeHistory(report, sessions);
    expect(rows).toHaveLength(2);
    expect(rows[0].cost).toBe(5.50);
    expect(rows[0].model).toBe("claude-sonnet-4-6");
  });

  it("sorts newest-first by date", () => {
    const rows = mergeHistory(report, sessions);
    expect(new Date(rows[0].date).getTime()).toBeGreaterThan(new Date(rows[1].date).getTime());
  });

  it("uses avgCacheRatio from report over sessions cacheRatio", () => {
    const rows = mergeHistory(report, sessions);
    expect(rows[0].cacheRatio).toBe(0.95);
  });

  it("defaults cost to 0 and model to empty string when no session match", () => {
    const rows = mergeHistory(report, []);
    expect(rows[0].cost).toBe(0);
    expect(rows[0].model).toBe("");
  });

  it("defaults wasteFactor to 1.0 when undefined", () => {
    const r: ReportSession[] = [
      { label: "quick/X", turns: 5, wasteFactor: undefined as any, totalTokens: 10_000, date: "2026-04-16T00:00:00Z", avgCacheRatio: 0.9 },
    ];
    const rows = mergeHistory(r, []);
    expect(rows[0].wasteFactor).toBe(1.0);
  });

  it("is case-insensitive on project name matching", () => {
    const r: ReportSession[] = [
      { label: "quick/MYPROJECT", turns: 20, wasteFactor: 2.0, totalTokens: 200_000, date: "2026-04-15T00:00:00Z", avgCacheRatio: 0.9 },
    ];
    const s: ClauditorSession[] = [
      { label: "MyProject (main)", turns: 20, cacheRatio: 0.88, cost: 3.00, model: "claude-sonnet-4-6", lastUpdated: "2026-04-15T00:00:00Z" },
    ];
    const rows = mergeHistory(r, s);
    expect(rows[0].cost).toBe(3.00);
  });
});
