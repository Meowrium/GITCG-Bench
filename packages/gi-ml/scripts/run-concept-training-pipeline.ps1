# Copyright (C) 2024-2025 Guyutongxue
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.

param(
  [string]$RunLabel = "concept-training",
  [string]$DatasetInput = "",
  [string]$CombatConceptsInput = "",
  [string]$ComboConceptsInput = "",
  [string]$TreeLakeInput = "",
  [ValidateSet("laptop", "cloud")]
  [string]$TrainPreset = "laptop",
  [switch]$SkipAutoExportComboConcepts,
  [switch]$SkipAutoExportBranchEvalComboConcepts,
  [switch]$SkipInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$scriptPathWin = Join-Path $repoRoot "packages/gi-ml/scripts/run-concept-training-pipeline.sh"

if (-not (Test-Path $scriptPathWin)) {
  throw "Script not found: $scriptPathWin"
}

function Convert-ToWslPath {
  param([Parameter(Mandatory = $true)][string]$WindowsPath)

  $resolved = (Resolve-Path $WindowsPath).Path
  $drive = $resolved.Substring(0, 1).ToLowerInvariant()
  $rest = $resolved.Substring(2).Replace("\", "/")
  return "/mnt/$drive$rest"
}

$scriptPathWsl = Convert-ToWslPath -WindowsPath $scriptPathWin
$datasetInputWsl = if ($DatasetInput) { Convert-ToWslPath -WindowsPath $DatasetInput } else { "" }
$combatConceptsInputWsl = if ($CombatConceptsInput) { Convert-ToWslPath -WindowsPath $CombatConceptsInput } else { "" }
$comboConceptsInputWsl = if ($ComboConceptsInput) { Convert-ToWslPath -WindowsPath $ComboConceptsInput } else { "" }
$treeLakeInputWsl = if ($TreeLakeInput) { Convert-ToWslPath -WindowsPath $TreeLakeInput } else { "" }
$installEnv = if ($SkipInstall) { "0" } else { "1" }
$autoExportComboConcepts = if ($SkipAutoExportComboConcepts) { "0" } else { "1" }
$autoExportBranchEvalComboConcepts = if ($SkipAutoExportBranchEvalComboConcepts) { "0" } else { "1" }

$envAssignments = @(
  "RUN_LABEL='$RunLabel'",
  "TRAIN_PRESET='$TrainPreset'",
  "AUTO_EXPORT_COMBO_CONCEPTS='$autoExportComboConcepts'",
  "AUTO_EXPORT_BRANCH_EVAL_COMBO_CONCEPTS='$autoExportBranchEvalComboConcepts'",
  "INSTALL_ENV='$installEnv'"
)

if ($datasetInputWsl) {
  $envAssignments += "DATASET_INPUT='$datasetInputWsl'"
}
if ($combatConceptsInputWsl) {
  $envAssignments += "COMBAT_CONCEPTS_INPUT='$combatConceptsInputWsl'"
}
if ($comboConceptsInputWsl) {
  $envAssignments += "COMBO_CONCEPTS_INPUT='$comboConceptsInputWsl'"
}
if ($treeLakeInputWsl) {
  $envAssignments += "TREE_LAKE_INPUT='$treeLakeInputWsl'"
}

$bashCommand = @(
  ($envAssignments -join " "),
  "bash '$scriptPathWsl'"
) -join " "

wsl.exe -d Ubuntu bash -lc $bashCommand
