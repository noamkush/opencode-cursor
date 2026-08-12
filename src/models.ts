/**
 * Cursor model discovery via GetUsableModels.
 * Uses the H2 bridge for transport. Falls back to a hardcoded list
 * when discovery fails.
 */
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { callCursorUnaryRpc } from "./proxy";
import {
  GetEffectiveTokenLimitRequestSchema,
  GetEffectiveTokenLimitResponseSchema,
  ModelDetailsSchema as AiServerModelDetailsSchema,
} from "./proto/aiserver_pb";
import {
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
} from "./proto/agent_pb";

const GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
const GET_EFFECTIVE_TOKEN_LIMIT_PATH = "/aiserver.v1.AiService/GetEffectiveTokenLimit";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
const MODEL_LIMIT_CACHE_VERSION = 1;
const MODEL_LIMIT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MODEL_LIMIT_CACHE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const CONTEXT_LIMIT_LOOKUP_CONCURRENCY = 8;

const ModelLimitCacheSchema = z.object({
  version: z.literal(MODEL_LIMIT_CACHE_VERSION),
  models: z.record(z.object({
    refreshedAt: z.number().finite().nonnegative(),
    limit: z.number().finite().positive(),
  })),
});

type ModelLimitCache = z.infer<typeof ModelLimitCacheSchema>;

let pendingModelLimitCacheWrite = Promise.resolve();

const CursorModelDetailsSchema = z.object({
  modelId: z.string(),
  displayName: z.string().optional().catch(undefined),
  displayNameShort: z.string().optional().catch(undefined),
  displayModelId: z.string().optional().catch(undefined),
  aliases: z
    .array(z.unknown())
    .optional()
    .catch([])
    .transform((aliases) =>
      (aliases ?? []).filter(
        (alias: unknown): alias is string => typeof alias === "string",
      ),
    ),
  thinkingDetails: z.unknown().optional(),
});

type CursorModelDetails = z.infer<typeof CursorModelDetailsSchema>;

export interface CursorModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

const FALLBACK_MODELS: CursorModel[] = [
  // Composer models
  { id: "composer-1", name: "Composer 1", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "composer-1.5", name: "Composer 1.5", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
  // Claude models
  { id: "claude-4.6-opus-high", name: "Claude 4.6 Opus", reasoning: true, contextWindow: 200_000, maxTokens: 128_000 },
  { id: "claude-4.6-sonnet-medium", name: "Claude 4.6 Sonnet", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
  { id: "claude-4.5-sonnet", name: "Claude 4.5 Sonnet", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
  // GPT models
  { id: "gpt-5.4-medium", name: "GPT-5.4", reasoning: true, contextWindow: 272_000, maxTokens: 128_000 },
  { id: "gpt-5.2", name: "GPT-5.2", reasoning: true, contextWindow: 400_000, maxTokens: 128_000 },
  { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", reasoning: true, contextWindow: 400_000, maxTokens: 128_000 },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", reasoning: true, contextWindow: 400_000, maxTokens: 128_000 },
  { id: "gpt-5.3-codex-spark-preview", name: "GPT-5.3 Codex Spark", reasoning: true, contextWindow: 128_000, maxTokens: 128_000 },
  // Other models
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", reasoning: true, contextWindow: 1_000_000, maxTokens: 64_000 },
  { id: "grok-code-fast-1", name: "Grok Code Fast 1", reasoning: false, contextWindow: 128_000, maxTokens: 64_000 },
];

/**
 * Pseudo-model for Cursor's server-side Auto routing. Always exposed
 * alongside discovered models; the proxy maps it to Run modelId "default".
 */
const AUTO_MODEL: CursorModel = {
  id: "auto",
  name: "Auto",
  reasoning: false,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxTokens: DEFAULT_MAX_TOKENS,
};

async function fetchCursorUsableModels(
  apiKey: string,
): Promise<CursorModel[] | null> {
  try {
    const requestPayload = create(GetUsableModelsRequestSchema, {});
    const requestBody = toBinary(GetUsableModelsRequestSchema, requestPayload);

    const response = await callCursorUnaryRpc({
      accessToken: apiKey,
      rpcPath: GET_USABLE_MODELS_PATH,
      requestBody,
    });

    if (response.timedOut || response.exitCode !== 0 || response.body.length === 0) {
      return null;
    }

    const decoded = decodeGetUsableModelsResponse(response.body);
    if (!decoded) return null;

    const models = normalizeCursorModels(decoded.models, await fetchContextLimits(apiKey, decoded.models));
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

let cachedModels: CursorModel[] | null = null;

export async function getCursorModels(
  apiKey: string,
): Promise<CursorModel[]> {
  if (cachedModels) return cachedModels;
  const discovered = await fetchCursorUsableModels(apiKey);
  const models = discovered && discovered.length > 0 ? discovered : FALLBACK_MODELS;
  cachedModels = models.some((m) => m.id === AUTO_MODEL.id) ? models : [AUTO_MODEL, ...models];
  return cachedModels;
}

/** @internal Test-only. */
export function clearModelCache(): void {
  cachedModels = null;
}

function decodeGetUsableModelsResponse(payload: Uint8Array): {
  models: readonly unknown[];
} | null {
  try {
    return fromBinary(GetUsableModelsResponseSchema, payload);
  } catch {
    const framedBody = decodeConnectUnaryBody(payload);
    if (!framedBody) return null;
    try {
      return fromBinary(GetUsableModelsResponseSchema, framedBody);
    } catch {
      return null;
    }
  }
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 5) return null;

  let offset = 0;
  while (offset + 5 <= payload.length) {
    const flags = payload[offset]!;
    const view = new DataView(
      payload.buffer,
      payload.byteOffset + offset,
      payload.byteLength - offset,
    );
    const messageLength = view.getUint32(1, false);
    const frameEnd = offset + 5 + messageLength;
    if (frameEnd > payload.length) return null;

    // Compression flag
    if ((flags & 0b0000_0001) !== 0) return null;

    // End-of-stream flag — skip trailer frames
    if ((flags & 0b0000_0010) === 0) {
      return payload.subarray(offset + 5, frameEnd);
    }

    offset = frameEnd;
  }

  return null;
}

async function fetchContextLimits(
  apiKey: string,
  usableModels: readonly unknown[],
): Promise<Map<string, number>> {
  const modelIds = usableModels
    .map((model) => CursorModelDetailsSchema.safeParse(model))
    .filter((result) => result.success)
    .map((result) => result.data.modelId.trim())
    .filter(Boolean);

  const cache = await readModelLimitCache();
  const now = Date.now();
  const limits = new Map<string, number>();
  const staleModelIds: string[] = [];

  for (const modelId of [...new Set(modelIds)]) {
    const cached = cache.models[modelId];
    if (cached && now - cached.refreshedAt <= MODEL_LIMIT_CACHE_TTL_MS) {
      limits.set(modelId, cached.limit);
    } else {
      staleModelIds.push(modelId);
    }
  }

  const refreshed = await fetchEffectiveContextLimits(apiKey, staleModelIds);
  for (const modelId of staleModelIds) {
    const limit = refreshed.get(modelId) ?? cache.models[modelId]?.limit;
    if (limit) limits.set(modelId, limit);
  }

  const pruned = pruneModelLimitCache(cache, new Set(modelIds), now);
  if (staleModelIds.length > 0 || pruned) {
    for (const [modelId, limit] of refreshed) {
      cache.models[modelId] = { refreshedAt: now, limit };
    }
    writeModelLimitCache(cache);
  }

  return limits;
}

async function fetchEffectiveContextLimits(
  apiKey: string,
  modelIds: readonly string[],
): Promise<Map<string, number>> {
  const limits = new Map<string, number>();
  const uniqueModelIds = [...new Set(modelIds)];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < uniqueModelIds.length) {
      const modelId = uniqueModelIds[nextIndex++]!;
      const requestBody = toBinary(
        GetEffectiveTokenLimitRequestSchema,
        create(GetEffectiveTokenLimitRequestSchema, {
          modelDetails: create(AiServerModelDetailsSchema, { modelName: modelId }),
        }),
      );
      try {
        const response = await callCursorUnaryRpc({
          accessToken: apiKey,
          rpcPath: GET_EFFECTIVE_TOKEN_LIMIT_PATH,
          requestBody,
          timeoutMs: 3_000,
        });
        if (response.timedOut || response.exitCode !== 0 || response.body.length === 0) continue;
        const body = decodeConnectUnaryBody(response.body) ?? response.body;
        const { tokenLimit } = fromBinary(GetEffectiveTokenLimitResponseSchema, body);
        if (tokenLimit > 0) limits.set(modelId, tokenLimit);
      } catch {
        // Individual models may not support this endpoint; retain the fallback.
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(CONTEXT_LIMIT_LOOKUP_CONCURRENCY, uniqueModelIds.length) },
      worker,
    ),
  );
  return limits;
}

function getModelLimitCachePath(): string {
  const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cacheHome, "opencode-cursor", "model-limits.json");
}

async function readModelLimitCache(): Promise<ModelLimitCache> {
  try {
    const parsed = ModelLimitCacheSchema.safeParse(
      JSON.parse(await readFile(getModelLimitCachePath(), "utf8")),
    );
    if (parsed.success) return parsed.data;
  } catch {
    // Cache availability must not affect model discovery.
  }
  return { version: MODEL_LIMIT_CACHE_VERSION, models: {} };
}

function pruneModelLimitCache(
  cache: ModelLimitCache,
  usableModelIds: ReadonlySet<string>,
  now: number,
): boolean {
  let pruned = false;
  for (const [modelId, entry] of Object.entries(cache.models)) {
    if (!usableModelIds.has(modelId) && now - entry.refreshedAt > MODEL_LIMIT_CACHE_RETENTION_MS) {
      delete cache.models[modelId];
      pruned = true;
    }
  }
  return pruned;
}

function writeModelLimitCache(cache: ModelLimitCache): void {
  const path = getModelLimitCachePath();
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const serializedCache = JSON.stringify(cache);
  pendingModelLimitCacheWrite = pendingModelLimitCacheWrite.then(async () => {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temporaryPath, serializedCache, { mode: 0o600 });
      await rename(temporaryPath, path);
    } catch {
      // Cache writes are strictly best-effort.
    }
  });
}

function normalizeCursorModels(
  models: readonly unknown[],
  contextLimits: ReadonlyMap<string, number> = new Map(),
): CursorModel[] {
  if (models.length === 0) return [];

  const byId = new Map<string, CursorModel>();
  for (const model of models) {
    const normalized = normalizeSingleModel(model, contextLimits);
    if (normalized) byId.set(normalized.id, normalized);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeSingleModel(
  model: unknown,
  contextLimits: ReadonlyMap<string, number>,
): CursorModel | null {
  const parsed = CursorModelDetailsSchema.safeParse(model);
  if (!parsed.success) return null;

  const details = parsed.data;
  const id = details.modelId.trim();
  if (!id) return null;

  return {
    id,
    name: pickDisplayName(details, id),
    reasoning: Boolean(details.thinkingDetails),
    contextWindow: contextLimits.get(id) ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

function pickDisplayName(model: CursorModelDetails, fallbackId: string): string {
  const candidates = [
    model.displayName,
    model.displayNameShort,
    model.displayModelId,
    ...model.aliases,
    fallbackId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return fallbackId;
}
