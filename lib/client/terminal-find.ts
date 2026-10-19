/* Find in terminal: match colors and the result label. */

export const findDecorations = (dark: boolean) =>
  dark
    ? { matchBackground: "#5c4a17", matchOverviewRuler: "#c9a13a", activeMatchBackground: "#b8871c", activeMatchColorOverviewRuler: "#f2c14e" }
    : { matchBackground: "#fbe3a0", matchOverviewRuler: "#d9a520", activeMatchBackground: "#f5b941", activeMatchColorOverviewRuler: "#b7791f" };

/** "3 of 12", "12 matches" (past the highlight limit the addon can't tell which one is active), "No results" */
export function findLabel(query: string, result: { resultIndex: number; resultCount: number } | null): string {
  if (!query || !result) return "";
  if (result.resultCount === 0) return "No results";
  if (result.resultIndex < 0) return `${result.resultCount} ${result.resultCount === 1 ? "match" : "matches"}`;
  return `${result.resultIndex + 1} of ${result.resultCount}`;
}
