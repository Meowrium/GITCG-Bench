// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { parentPort, workerData } from "node:worker_threads";
import type { Version } from "@gi-tcg/core";
import getData from "@gi-tcg/data";
import { runBenchmarkSuite } from "../benchmark-suite.js";
import {
  buildBenchmarkMatchupsFromPlans,
  type BenchmarkExecutionPlan,
} from "../cli-config.js";

interface BenchmarkWorkerData {
  version: Version;
  configDir: string;
  plans: BenchmarkExecutionPlan[];
}

async function main() {
  const data = workerData as BenchmarkWorkerData;
  const matchups = await buildBenchmarkMatchupsFromPlans(data.plans, data.configDir);
  const result = await runBenchmarkSuite({
    data: getData(data.version),
    matchups,
  });
  parentPort?.postMessage(result);
}

await main();
