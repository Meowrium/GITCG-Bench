import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  getContractPaths,
  getIndexPath,
  resolveCanonicalToolName,
  type TacticCanonicalToolName,
  type TacticToolName,
  type ToolContractsIndex,
} from "./registry/tool-registry";
import {
  buildSchemaResult,
  buildSemanticRequestResult,
  buildSemanticResponseResult,
  buildUnknownToolError,
} from "./validation";

export type TacticValidationStage = "request" | "response";

export type TacticValidationError = {
  error_code: string;
  message: string;
  recover_hint: string;
  details?: Array<{
    field: string;
    rule: string;
    message: string;
    params?: Record<string, unknown>;
  }>;
};

export type TacticValidationResult =
  | { ok: true }
  | { ok: false; error: TacticValidationError };

type ToolValidatorPair = {
  request: ValidateFunction
  response: ValidateFunction
};

export class TacticToolContractValidator {
  private readonly validators = new Map<TacticCanonicalToolName, ToolValidatorPair>()

  private constructor(validators: Map<TacticCanonicalToolName, ToolValidatorPair>) {
    this.validators = validators
  }

  static async create(options?: { schemasRoot?: string }): Promise<TacticToolContractValidator> {
    const schemasRoot = options?.schemasRoot ?? resolve(import.meta.dir, "../schemas")
    const indexPath = getIndexPath(schemasRoot)

    const index = await TacticToolContractValidator.readJsonFile<ToolContractsIndex>(indexPath)
    if (!index || !Array.isArray(index.tools)) {
      throw new Error(`Invalid tool contracts index at ${indexPath}`)
    }

    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })

    const jsonFiles = await TacticToolContractValidator.collectJsonFiles(schemasRoot)
    for (const filePath of jsonFiles) {
      const schema = await TacticToolContractValidator.readJsonFile<Record<string, unknown>>(filePath)
      const id = typeof schema?.$id === "string" ? schema.$id : null
      if (id) {
        ajv.addSchema(schema, id)
      }
    }

    const validators = new Map<TacticCanonicalToolName, ToolValidatorPair>()

    for (const tool of index.tools) {
      const { requestSchemaPath, responseSchemaPath } = getContractPaths(schemasRoot, tool)

      const requestSchema = await TacticToolContractValidator.readJsonFile<Record<string, unknown>>(requestSchemaPath)
      const responseSchema = await TacticToolContractValidator.readJsonFile<Record<string, unknown>>(responseSchemaPath)
      const requestSchemaId = typeof requestSchema.$id === "string" ? requestSchema.$id : null
      const responseSchemaId = typeof responseSchema.$id === "string" ? responseSchema.$id : null

      const requestValidate = requestSchemaId
        ? (ajv.getSchema(requestSchemaId) ?? ajv.compile(requestSchema))
        : ajv.compile(requestSchema)
      const responseValidate = responseSchemaId
        ? (ajv.getSchema(responseSchemaId) ?? ajv.compile(responseSchema))
        : ajv.compile(responseSchema)

      validators.set(tool.name, {
        request: requestValidate,
        response: responseValidate,
      })
    }

    return new TacticToolContractValidator(validators)
  }

  validateRequest(toolName: TacticToolName | string, args: Record<string, unknown>): TacticValidationResult {
    const canonicalToolName = resolveCanonicalToolName(toolName)
    if (!canonicalToolName) {
      return {
        ok: false,
        error: buildUnknownToolError(toolName),
      }
    }

    const pair = this.validators.get(canonicalToolName)
    if (!pair) {
      return {
        ok: false,
        error: buildUnknownToolError(toolName),
      }
    }

    const payload = {
      name: canonicalToolName,
      arguments: args,
    }

    if (pair.request(payload)) {
      return buildSemanticRequestResult(canonicalToolName, args)
    }

    return buildSchemaResult("request", canonicalToolName, pair.request.errors ?? [])
  }

  validateResponse(toolName: TacticToolName | string, response: Record<string, unknown>): TacticValidationResult {
    const canonicalToolName = resolveCanonicalToolName(toolName)
    if (!canonicalToolName) {
      return {
        ok: false,
        error: buildUnknownToolError(toolName),
      }
    }

    const pair = this.validators.get(canonicalToolName)
    if (!pair) {
      return {
        ok: false,
        error: buildUnknownToolError(toolName),
      }
    }

    if (pair.response(response)) {
      return buildSemanticResponseResult(canonicalToolName, response)
    }

    return buildSchemaResult("response", canonicalToolName, pair.response.errors ?? [])
  }

  private static async readJsonFile<T>(filePath: string): Promise<T> {
    const raw = await readFile(filePath, "utf-8")
    return JSON.parse(raw) as T
  }

  private static async collectJsonFiles(dirPath: string): Promise<string[]> {
    const entries = await readdir(dirPath, { withFileTypes: true })
    const files: string[] = []

    for (const entry of entries) {
      const fullPath = resolve(dirPath, entry.name)
      if (entry.isDirectory()) {
        files.push(...(await TacticToolContractValidator.collectJsonFiles(fullPath)))
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(fullPath)
      }
    }

    return files
  }
}
