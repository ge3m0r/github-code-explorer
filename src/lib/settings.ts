export interface AppSettings {
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
  githubToken: string;
  maxDrillDepth: number;
  maxKeySubFunctionsPerLayer: number;
}

export interface SettingsEnvSnapshot {
  aiBaseUrl: string;
  aiModel: string;
  maxDrillDepth: number;
  aiApiKeyConfigured: boolean;
  githubTokenConfigured: boolean;
}

const STORAGE_KEY = 'github-code-explorer:settings';
const DEFAULT_SETTINGS: AppSettings = {
  aiBaseUrl: '',
  aiApiKey: '',
  aiModel: 'deepseek-chat',
  githubToken: '',
  maxDrillDepth: 2,
  maxKeySubFunctionsPerLayer: 10,
};

type SettingsListener = (next: AppSettings) => void;

let cached: AppSettings | null = null;
const listeners = new Set<SettingsListener>();

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function safeParseInt(value: unknown, fallback: number) {
  const num = typeof value === 'string' ? parseInt(value, 10) : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num;
}

function clampInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function readPersisted(): Partial<AppSettings> {
  if (!canUseStorage()) {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw) as Partial<Record<keyof AppSettings, unknown>>;
    return {
      aiBaseUrl: typeof data.aiBaseUrl === 'string' ? data.aiBaseUrl : undefined,
      aiApiKey: typeof data.aiApiKey === 'string' ? data.aiApiKey : undefined,
      aiModel: typeof data.aiModel === 'string' ? data.aiModel : undefined,
      githubToken: typeof data.githubToken === 'string' ? data.githubToken : undefined,
      maxDrillDepth: typeof data.maxDrillDepth !== 'undefined' ? safeParseInt(data.maxDrillDepth, DEFAULT_SETTINGS.maxDrillDepth) : undefined,
      maxKeySubFunctionsPerLayer:
        typeof data.maxKeySubFunctionsPerLayer !== 'undefined'
          ? safeParseInt(data.maxKeySubFunctionsPerLayer, DEFAULT_SETTINGS.maxKeySubFunctionsPerLayer)
          : undefined,
    };
  } catch {
    return {};
  }
}

function writePersisted(next: AppSettings) {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 忽略写入失败（例如隐私模式或配额不足）
  }
}

function readEnvRaw() {
  const env = process.env as Record<string, string | undefined>;
  const aiBaseUrl = (env.AI_BASE_URL || '').trim();
  const aiApiKey = (env.AI_API_KEY || env.GEMINI_API_KEY || '').trim();
  const aiModel = (env.AI_MODEL || DEFAULT_SETTINGS.aiModel).trim();
  const githubToken = (env.GITHUB_TOKEN || '').trim();
  const maxDrillDepth = safeParseInt(env.AI_DRILL_DOWN_MAX_DEPTH || DEFAULT_SETTINGS.maxDrillDepth, DEFAULT_SETTINGS.maxDrillDepth);
  return { aiBaseUrl, aiApiKey, aiModel, githubToken, maxDrillDepth };
}

function normalizeSettings(input: Partial<AppSettings>): AppSettings {
  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...input,
  };

  return {
    aiBaseUrl: (merged.aiBaseUrl || '').trim(),
    aiApiKey: (merged.aiApiKey || '').trim(),
    aiModel: (merged.aiModel || DEFAULT_SETTINGS.aiModel).trim() || DEFAULT_SETTINGS.aiModel,
    githubToken: (merged.githubToken || '').trim(),
    maxDrillDepth: clampInt(safeParseInt(merged.maxDrillDepth, DEFAULT_SETTINGS.maxDrillDepth), 0, 20),
    maxKeySubFunctionsPerLayer: clampInt(
      safeParseInt(merged.maxKeySubFunctionsPerLayer, DEFAULT_SETTINGS.maxKeySubFunctionsPerLayer),
      1,
      50,
    ),
  };
}

function applyEnvOverride(persisted: Partial<AppSettings>) {
  const env = readEnvRaw();
  const next: Partial<AppSettings> = { ...persisted };

  // 规则：如果启动时环境变量与持久化不一致，以环境变量为准（仅针对这些字段）
  if (env.aiBaseUrl) next.aiBaseUrl = env.aiBaseUrl;
  if (env.aiApiKey) next.aiApiKey = env.aiApiKey;
  if (env.aiModel) next.aiModel = env.aiModel;
  if (env.githubToken) next.githubToken = env.githubToken;
  if (Number.isFinite(env.maxDrillDepth)) next.maxDrillDepth = env.maxDrillDepth;

  return normalizeSettings(next);
}

function ensureInitialized() {
  if (cached) return;
  const persisted = readPersisted();
  const computed = applyEnvOverride(persisted);
  cached = computed;

  // 如果环境变量覆盖导致与本地不一致，写回本地，保证后续一致
  writePersisted(computed);
}

export function getSettings(): AppSettings {
  ensureInitialized();
  return cached!;
}

export function saveSettings(partial: Partial<AppSettings>) {
  ensureInitialized();
  const next = normalizeSettings({ ...cached!, ...partial });
  cached = next;
  writePersisted(next);
  for (const listener of listeners) {
    try {
      listener(next);
    } catch {
      // ignore
    }
  }
}

export function subscribeSettings(listener: SettingsListener) {
  ensureInitialized();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSettingsEnvSnapshot(): SettingsEnvSnapshot {
  const env = readEnvRaw();
  return {
    aiBaseUrl: env.aiBaseUrl,
    aiModel: env.aiModel,
    maxDrillDepth: clampInt(env.maxDrillDepth, 0, 20),
    aiApiKeyConfigured: !!env.aiApiKey,
    githubTokenConfigured: !!env.githubToken,
  };
}

