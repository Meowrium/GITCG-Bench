import { readFileSync } from "node:fs"
import { V30NeuralPredictor } from "../src/learning/encoder/neural-predictor.js"

const weightsPath = "examples/output/v30-encoder-smoke/encoder-weights.json"
const trainNdjson = "examples/output/v30-encoder-smoke/dataset/train.ndjson"

const predictor = V30NeuralPredictor.fromFile(weightsPath)
console.log("Loaded predictor")

const lines = readFileSync(trainNdjson, "utf8").trim().split("\n").slice(0, 5)
console.log(`Predicting ${lines.length} real self-play observations...`)
for (let i = 0; i < lines.length; i++) {
  const rec = JSON.parse(lines[i])
  const out = predictor.predict({ observation: rec.observation })
  const top = out.q.indexOf(Math.max(...out.q))
  console.log(
    `record ${i}: candidates=${out.candidateIds.length} V=${out.v.toFixed(4)} ` +
    `top_q=${out.q[top].toFixed(4)} top_winProb=${out.winProb[top].toFixed(4)} label=${rec.label}`,
  )
}
