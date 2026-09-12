// Crawl per-version deck stats from summoners.top API v4.
// Output: one JSON per game version with deckCode, character names, usage rate, win rate.
const BASE = "https://www.summoners.top/api/v4"
const UA = { "User-Agent": "Mozilla/5.0 (research script)" }
const VERSIONS = ["4.0", "4.8", "5.3", "5.8", "6.3"]
const OUT_DIR = "D:/AI/GTCG/genius-invokation-clean/packages/benchmark/tree-bench/summoners-decks/raw"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function get(path) {
  const res = await fetch(BASE + path, { headers: UA })
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
  return res.json()
}

const [cardsData, overview, gameVersions] = await Promise.all([
  get("/cards-data"),
  get("/overview-stats"),
  get("/game-versions"),
])
const charName = (id) => cardsData.characterCards[id]?.name ?? null
const deckGames = Object.fromEntries(overview.map((o) => [o.gameVersion, o.numGamesWithDeck]))
const versionName = Object.fromEntries(gameVersions.map((v) => [v.id, v.name ?? null]))

for (const version of VERSIONS) {
  const teams = await get(`/teams-stats?gameVersion=${version}`)
  const decks = []
  for (const team of teams) {
    const teamDecks = await get(`/teams/${team.teamId}/decks-stats?gameVersion=${version}`)
    const ids = team.teamId.split("-")
    const names = ids.map((id) => charName(id))
    for (const d of teamDecks) {
      decks.push({
        deckCode: d.deckCode,
        teamId: team.teamId,
        characters: ids.map((id, i) => names[i]?.zh ?? id),
        charactersEn: ids.map((id, i) => names[i]?.en ?? null),
        numGames: d.numGames,
        numGamesWin: d.numGamesWin,
        usageRate: +(d.numGames / (deckGames[version] || 1)).toFixed(6),
        winRate: d.numGames ? +(d.numGamesWin / d.numGames).toFixed(4) : null,
      })
    }
    await sleep(150)
  }
  decks.sort((a, b) => b.numGames - a.numGames)
  const out = {
    source: "https://www.summoners.top/",
    api: `${BASE}/teams-stats?gameVersion=${version} + /teams/{teamId}/decks-stats?gameVersion=${version}`,
    gameVersion: version,
    versionName: versionName[version] ?? null,
    numGamesWithDeck: deckGames[version] ?? null,
    usageRateDefinition: "numGames / numGamesWithDeck (ratio, 0-1)",
    winRateDefinition: "numGamesWin / numGames (ratio, 0-1)",
    deckCount: decks.length,
    decks,
  }
  const file = `${OUT_DIR}/${version}.json`
  await import("node:fs").then((fs) => {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n", "utf-8")
  })
  console.log(`[${version}] teams=${teams.length} decks=${decks.length} gamesWithDeck=${deckGames[version]}`)
}
