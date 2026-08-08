import { z } from "zod";

export const userSettingsSchema = z
  .object({
    theme: z.enum(["system", "light", "dark"]).default("system"),
    locale: z.enum(["zh-CN", "en"]).default("zh-CN"),
    reducedMotion: z.boolean().default(false),
    autosaveDebounceMs: z.number().int().min(250).max(5_000).default(1_000),
    backupEnabled: z.boolean().default(true),
    backupIntervalMinutes: z.number().int().min(5).max(1_440).default(30),
    backupRetentionDays: z.number().int().min(1).max(3_650).default(30),
    syncEnabled: z.boolean().default(false),
    telemetryEnabled: z.boolean().default(false),
    automaticMemoryLearning: z.boolean().default(false),
    remoteModelDataPolicy: z
      .enum(["ask_every_time", "allow_for_project", "deny"])
      .default("ask_every_time"),
    updateChannel: z.enum(["stable", "beta", "nightly"]).default("stable"),
    automaticUpdates: z.boolean().default(true),
    diagnosticsRedaction: z.literal(true).default(true),
    wordCountMode: z.enum(["cjk_characters", "unicode_words", "both"]).default("cjk_characters"),
  })
  .strict();

export type UserSettings = z.infer<typeof userSettingsSchema>;

export const DEFAULT_USER_SETTINGS: Readonly<UserSettings> = Object.freeze(
  userSettingsSchema.parse({}),
);

export function parseUserSettings(input: unknown): UserSettings {
  return userSettingsSchema.parse(input ?? {});
}
