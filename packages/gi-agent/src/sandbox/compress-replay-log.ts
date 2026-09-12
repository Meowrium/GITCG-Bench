import { readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

interface RawReplayLog {
  v: string
  store: any[]
  log: Array<{ s: { $: number }; e: unknown[]; r: boolean }>
  gv: string
}

interface CompressedReplay {
  v: string
  gv: string
  matchup: string
  result: { winner: number | null; totalRounds: number }
  initialState: InitialState
  turns: TurnRecord[]
}

interface InitialState {
  players: Array<{
    characters: Array<{ id: number; hp: number; energy: number }>
    deck: number[]
  }>
}

interface TurnRecord {
  r: number
  t: 0 | 1
  p: string
  d?: string[]
  hp: number[][]
  en: number[][]
  h: [number, number]
  ac: [number, number]
  sm: [number[], number[]]
  sp: [number[], number[]]
  ev: string[]
}

function resolveRef(store: any[], idx: number): any {
  const v = store[idx]
  if (v && typeof v === "object" && !Array.isArray(v) && "$" in v && typeof v.$ === "number") {
    return store[v.$]
  }
  return v
}

function get(store: any[], refOrVal: any): any {
  if (refOrVal && typeof refOrVal === "object" && "$" in refOrVal && typeof refOrVal.$ === "number") {
    return store[refOrVal.$]
  }
  return refOrVal
}

function readPlayerCompact(store: any[], stateIdx: number, playerIdx: number) {
  const state = store[stateIdx]
  const players = get(store, state?.players)
  const playerRef = players?.[playerIdx]
  const player = get(store, playerRef)
  if (!player) return null

  const activeCharId = player.activeCharacterId ?? 0
  const characters = get(store, player.characters)
  if (!Array.isArray(characters)) return null

  const charData: Array<{ id: number; hp: number; energy: number }> = []
  let activeIdx = 0
  for (let i = 0; i < characters.length; i++) {
    const ch = get(store, characters[i])
    if (!ch) continue
    const def = get(store, ch.definition)
    const vars = get(store, ch.variables)
    const charId = def?.id ?? ch.id ?? 0
    charData.push({
      id: charId,
      hp: vars?.health ?? 0,
      energy: vars?.energy ?? 0,
    })
    if (ch.id === activeCharId) activeIdx = i
  }

  const hands = get(store, player.hands)
  const dice = get(store, player.dice)

  const extractIds = (field: string): number[] => {
    const arr = get(store, player[field])
    if (!Array.isArray(arr)) return []
    return arr.map((item: any) => {
      const obj = get(store, item)
      const def = get(store, obj?.definition)
      return def?.id ?? obj?.id ?? 0
    })
  }

  return {
    activeIdx,
    characters: charData,
    handsCount: Array.isArray(hands) ? hands.length : 0,
    dice: Array.isArray(dice) ? dice : [],
    summons: extractIds("summons"),
    supports: extractIds("supports"),
  }
}

function readStateMeta(store: any[], stateIdx: number) {
  const state = store[stateIdx]
  return {
    phase: state?.phase ?? "",
    roundNumber: state?.roundNumber ?? 0,
    currentTurn: (state?.currentTurn ?? 0) as 0 | 1,
    winner: state?.winner ?? null,
  }
}

function extractDeckIds(store: any[], stateIdx: number, playerIdx: number): number[] {
  const player = get(store, get(store, store[stateIdx]?.players)?.[playerIdx])
  const pile = get(store, player?.initialPile)
  if (!Array.isArray(pile)) return []
  return pile.map((item: any) => {
    const obj = get(store, item)
    const def = get(store, obj?.definition)
    return def?.id ?? obj?.id ?? 0
  })
}

function collectLogTreeEvents(store: any[]): Array<{ type: string; value: string; round: number; turn: number }> {
  const results: Array<{ type: string; value: string; round: number; turn: number }> = []
  let currentRound = 0
  let currentTurn: 0 | 1 = 0

  for (let i = 0; i < store.length; i++) {
    const item = store[i]
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    if (item.type === "phase" && typeof item.value === "string") {
      const phaseMatch = item.value.match(/round (\d+)/)
      if (phaseMatch) currentRound = parseInt(phaseMatch[1])
      const turnMatch = item.value.match(/turn (\d+)/)
      if (turnMatch) currentTurn = parseInt(turnMatch[1]) as 0 | 1

      if (item.value.includes("action phase")) {
        results.push({ type: "phase", value: item.value, round: currentRound, turn: currentTurn })
      }
    }
    if (item.type === "skill" && typeof item.value === "string") {
      results.push({ type: "skill", value: item.value, round: currentRound, turn: currentTurn })
    }
    if (item.type === "mutation" && typeof item.value === "string") {
      if (isInterestingMutation(item.value)) {
        results.push({ type: "mutation", value: item.value, round: currentRound, turn: currentTurn })
      }
    }
  }
  return results
}

function isInterestingMutation(value: string): boolean {
  return /Modify variable (health|energy)|Switch active|defeated|Remove.*aura|Apply.*status|absorbed|Reaction|Swirl|Crystallize|Superconduct|Overloaded|Electro-Charged|Frozen|Melt|Vaporize|Burgeon|Hyperbloom|Aggravate|Spread/i.test(value)
}

function formatMutation(value: string): string {
  return value
    .replace(/\(-\d+\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 150)
}

function formatDice(diceArr: any[]): string[] {
  const m: Record<number, string> = {
    0: "C", 1: "H", 2: "P", 3: "E", 4: "A", 5: "G", 6: "D", 7: "O", 8: "V",
  }
  return diceArr.map((d) => typeof d === "number" ? (m[d] ?? `${d}`) : `${d}`)
}

function arrEq(a: number[] | null | undefined, b: number[]): boolean {
  if (!a) return b.length === 0
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function compressReplayLog(raw: RawReplayLog, matchup: string): CompressedReplay {
  const { store, log } = raw

  const firstStateIdx = log[0].s.$
  let winner: number | null = null
  let totalRounds = 0
  for (let i = log.length - 1; i >= 0; i--) {
    const meta = readStateMeta(store, log[i].s.$)
    if (meta.phase === "gameEnd") {
      winner = typeof meta.winner === "number" ? meta.winner : null
      totalRounds = meta.roundNumber
      break
    }
  }

  const p0Init = readPlayerCompact(store, firstStateIdx, 0)
  const p1Init = readPlayerCompact(store, firstStateIdx, 1)

  const initialState: InitialState = {
    players: [
      { characters: p0Init?.characters ?? [], deck: extractDeckIds(store, firstStateIdx, 0) },
      { characters: p1Init?.characters ?? [], deck: extractDeckIds(store, firstStateIdx, 1) },
    ],
  }

  const logEvents = collectLogTreeEvents(store)
  const eventsByRoundTurn = new Map<string, string[]>()
  for (const ev of logEvents) {
    if (ev.type === "skill") {
      const key = `${ev.round}|${ev.turn}`
      if (!eventsByRoundTurn.has(key)) eventsByRoundTurn.set(key, [])
      const skillId = ev.value.match(/\[(.*?)\]/)?.[1] ?? ev.value
      eventsByRoundTurn.get(key)!.push(skillId)
    } else if (ev.type === "mutation") {
      const key = `${ev.round}|${ev.turn}`
      if (!eventsByRoundTurn.has(key)) eventsByRoundTurn.set(key, [])
      eventsByRoundTurn.get(key)!.push(formatMutation(ev.value))
    }
  }

  const turns: TurnRecord[] = []
  let prevHp0: number[] | null = null
  let prevHp1: number[] | null = null
  let prevEn0: number[] | null = null
  let prevEn1: number[] | null = null
  let prevH: [number, number] | null = null
  let prevAc: [number, number] | null = null

  for (let i = 0; i < log.length; i++) {
    const entry = log[i]
    const stateIdx = entry.s.$
    const meta = readStateMeta(store, stateIdx)

    if (meta.phase === "initHands" || meta.phase === "initActives") continue

    if (meta.phase === "gameEnd") {
      const p0 = readPlayerCompact(store, stateIdx, 0)
      const p1 = readPlayerCompact(store, stateIdx, 1)
      turns.push({
        r: meta.roundNumber, t: meta.currentTurn, p: "end",
        hp: [p0?.characters.map(c => c.hp) ?? [], p1?.characters.map(c => c.hp) ?? []],
        en: [p0?.characters.map(c => c.energy) ?? [], p1?.characters.map(c => c.energy) ?? []],
        h: [p0?.handsCount ?? 0, p1?.handsCount ?? 0],
        ac: [p0?.activeIdx ?? 0, p1?.activeIdx ?? 0],
        sm: [p0?.summons ?? [], p1?.summons ?? []],
        sp: [p0?.supports ?? [], p1?.supports ?? []],
        ev: [`winner=${winner ?? "draw"}`],
      })
      continue
    }

    if (meta.phase === "action" && entry.r) {
      const p0 = readPlayerCompact(store, stateIdx, 0)
      const p1 = readPlayerCompact(store, stateIdx, 1)

      const hp0 = p0?.characters.map(c => c.hp) ?? []
      const hp1 = p1?.characters.map(c => c.hp) ?? []
      const en0 = p0?.characters.map(c => c.energy) ?? []
      const en1 = p1?.characters.map(c => c.energy) ?? []
      const h: [number, number] = [p0?.handsCount ?? 0, p1?.handsCount ?? 0]
      const ac: [number, number] = [p0?.activeIdx ?? 0, p1?.activeIdx ?? 0]

      if (!arrEq(prevHp0, hp0) || !arrEq(prevHp1, hp1) ||
          !arrEq(prevEn0, en0) || !arrEq(prevEn1, en1) ||
          prevH?.[0] !== h[0] || prevH?.[1] !== h[1] ||
          prevAc?.[0] !== ac[0] || prevAc?.[1] !== ac[1]) {

        const currentPlayer = meta.currentTurn === 0 ? p0 : p1
        const dice = currentPlayer?.dice?.length ? formatDice(currentPlayer.dice) : undefined
        const evKey = `${meta.roundNumber}|${meta.currentTurn}`
        const ev = eventsByRoundTurn.get(evKey) ?? []
        eventsByRoundTurn.delete(evKey)

        turns.push({
          r: meta.roundNumber, t: meta.currentTurn, p: "act", d: dice,
          hp: [hp0, hp1], en: [en0, en1], h, ac,
          sm: [p0?.summons ?? [], p1?.summons ?? []],
          sp: [p0?.supports ?? [], p1?.supports ?? []],
          ev,
        })

        prevHp0 = hp0; prevHp1 = hp1
        prevEn0 = en0; prevEn1 = en1
        prevH = h; prevAc = ac
      }
    } else if (meta.phase === "roll") {
      const p0 = readPlayerCompact(store, stateIdx, 0)
      const p1 = readPlayerCompact(store, stateIdx, 1)
      const currentPlayer = meta.currentTurn === 0 ? p0 : p1
      const dice = currentPlayer?.dice?.length ? formatDice(currentPlayer.dice) : undefined
      turns.push({
        r: meta.roundNumber, t: meta.currentTurn, p: "roll", d: dice,
        hp: [p0?.characters.map(c => c.hp) ?? [], p1?.characters.map(c => c.hp) ?? []],
        en: [p0?.characters.map(c => c.energy) ?? [], p1?.characters.map(c => c.energy) ?? []],
        h: [p0?.handsCount ?? 0, p1?.handsCount ?? 0],
        ac: [p0?.activeIdx ?? 0, p1?.activeIdx ?? 0],
        sm: [[], []], sp: [[], []], ev: [],
      })
    }
  }

  return { v: raw.v, gv: raw.gv, matchup, result: { winner, totalRounds }, initialState, turns }
}

async function compressFile(inputPath: string, outputPath: string): Promise<{ inputSize: number; outputSize: number }> {
  const raw = JSON.parse(await readFile(inputPath, "utf8")) as RawReplayLog
  const matchup = basename(dirname(inputPath))
  const compressed = compressReplayLog(raw, matchup)
  const outputJson = JSON.stringify(compressed)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${outputJson}\n`, "utf8")
  return {
    inputSize: Buffer.byteLength(JSON.stringify(raw), "utf8"),
    outputSize: Buffer.byteLength(outputJson, "utf8"),
  }
}

async function compressDirectory(
  inputDir: string,
  outputDir: string,
  prefix: string = "compact-",
): Promise<void> {
  const subdirs = (await readdir(inputDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  let totalInput = 0
  let totalOutput = 0
  let fileCount = 0

  for (const subdir of subdirs) {
    const files = (await readdir(join(inputDir, subdir)))
      .filter((f) => f.endsWith(".json") && !f.startsWith(prefix))

    for (const file of files) {
      const inputPath = join(inputDir, subdir, file)
      const outputPath = join(outputDir, subdir, `${prefix}${file}`)
      const { inputSize, outputSize } = await compressFile(inputPath, outputPath)
      totalInput += inputSize
      totalOutput += outputSize
      fileCount++
      const ratio = ((1 - outputSize / inputSize) * 100).toFixed(1)
      console.log(`[${fileCount}] ${subdir}/${file}: ${(inputSize / 1024).toFixed(1)}KB -> ${(outputSize / 1024).toFixed(1)}KB (${ratio}% reduction)`)
    }
  }

  console.log(`\n=== Summary ===`)
  console.log(`Files: ${fileCount}`)
  console.log(`Total input: ${(totalInput / 1024 / 1024).toFixed(2)} MB`)
  console.log(`Total output: ${(totalOutput / 1024 / 1024).toFixed(2)} MB`)
  console.log(`Overall reduction: ${((1 - totalOutput / totalInput) * 100).toFixed(1)}%`)
  console.log(`Average output: ${(totalOutput / fileCount / 1024).toFixed(1)} KB/file`)
}

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    console.error("Usage:")
    console.error("  pnpm exec gnx src/sandbox/compress-replay-log.ts <inputDir> [outputDir] [--prefix <prefix>]")
    console.error("  pnpm exec gnx src/sandbox/compress-replay-log.ts <inputFile> <outputFile>")
    console.error("")
    console.error("Default prefix: compact-")
    process.exit(1)
  }

  let prefix = "compact-"
  const prefixIdx = args.indexOf("--prefix")
  if (prefixIdx !== -1 && args[prefixIdx + 1]) {
    prefix = args[prefixIdx + 1]
    args.splice(prefixIdx, 2)
  }

  const inputPath = resolve(args[0])

  if (args.length >= 2 && args[1].endsWith(".json")) {
    const outputPath = resolve(args[1])
    const { inputSize, outputSize } = await compressFile(inputPath, outputPath)
    const ratio = ((1 - outputSize / inputSize) * 100).toFixed(1)
    console.log(`Input: ${(inputSize / 1024).toFixed(1)}KB`)
    console.log(`Output: ${(outputSize / 1024).toFixed(1)}KB`)
    console.log(`Reduction: ${ratio}%`)
    return
  }

  const outputDir = args[1] ? resolve(args[1]) : inputPath
  await compressDirectory(inputPath, outputDir, prefix)
}

main().catch((err) => {
  console.error("Error:", err)
  process.exit(1)
})
