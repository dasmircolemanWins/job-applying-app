import { existsSync } from "node:fs";
import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { apiKeySource, isMockActive, IS_PRODUCTION, maskApiKey, readSetting, readSettingOrDefault, resolveApiKey, writeSetting } from "../config.js";
import { asyncHandler, validate } from "../http.js";
import { DATA_DIR } from "../paths.js";
import { chromium } from "playwright";
import { EFFORT_LEVELS, MOCK_MODES } from "../../../shared/types.js";

export const router = Router();

const updateSchema = z.object({
  anthropicApiKey: z.string().max(500).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  autoSubmit: z.boolean().optional(),
  imapHost: z.string().max(255).optional(),
  imapPort: z.number().int().min(1).max(65535).optional(),
  imapUser: z.string().max(255).optional(),
  imapPassword: z.string().max(500).optional(),
  imapFolder: z.string().max(255).optional(),
  dailyTarget: z.number().int().min(1).max(10000).optional(),
  mockMode: z.enum(MOCK_MODES).optional(),
}).strict();

function settings() {
  const savedKey = readSetting("anthropic_api_key");
  let browserInstalled = false;
  try { browserInstalled = existsSync(chromium.executablePath()); } catch { /* browser is optional */ }
  return {
    anthropicApiKeyMasked: maskApiKey(savedKey),
    hasApiKey: !!resolveApiKey(),
    apiKeySource: apiKeySource(),
    model: readSettingOrDefault("model"),
    effort: readSettingOrDefault("effort"),
    autoSubmit: readSettingOrDefault("auto_submit") === "1",
    imapHost: readSettingOrDefault("imap_host"),
    imapPort: Number(readSettingOrDefault("imap_port")) || 993,
    imapUser: readSettingOrDefault("imap_user"),
    imapPasswordSet: !!readSetting("imap_password"),
    imapFolder: readSettingOrDefault("imap_folder"),
    dailyTarget: Number(readSettingOrDefault("daily_target")) || 70,
    mockMode: readSettingOrDefault("mock_mode"),
    mockActive: isMockActive(),
    dataDir: IS_PRODUCTION ? "Persistent app storage" : DATA_DIR,
    browserInstalled,
  };
}

router.get("/settings", (_req, res) => res.json(settings()));

router.put("/settings", asyncHandler((req, res) => {
  const body = validate(req.body, updateSchema);
  if (body.anthropicApiKey !== undefined) writeSetting("anthropic_api_key", body.anthropicApiKey.trim());
  if (body.model !== undefined) writeSetting("model", body.model);
  if (body.effort !== undefined) writeSetting("effort", body.effort);
  if (body.autoSubmit !== undefined) writeSetting("auto_submit", body.autoSubmit ? "1" : "0");
  if (body.imapHost !== undefined) writeSetting("imap_host", body.imapHost);
  if (body.imapPort !== undefined) writeSetting("imap_port", String(body.imapPort));
  if (body.imapUser !== undefined) writeSetting("imap_user", body.imapUser);
  if (body.imapPassword !== undefined) writeSetting("imap_password", body.imapPassword);
  if (body.imapFolder !== undefined) writeSetting("imap_folder", body.imapFolder);
  if (body.dailyTarget !== undefined) writeSetting("daily_target", String(body.dailyTarget));
  if (body.mockMode !== undefined) writeSetting("mock_mode", body.mockMode);
  res.json(settings());
}));

router.post("/settings/test-key", asyncHandler(async (_req, res) => {
  if (isMockActive() || !resolveApiKey()) {
    res.json({ ok: false, model: readSettingOrDefault("model"), message: "Mock mode is active; no API key test was sent." });
    return;
  }
  try {
    const { getClient } = await import("../agents/client.js");
    const client = getClient();
    await client.messages.create({ model: readSettingOrDefault("model"), max_tokens: 8, messages: [{ role: "user", content: "Reply with OK." }] });
    res.json({ ok: true, model: readSettingOrDefault("model"), message: "API key is valid." });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      res.json({ ok: false, model: readSettingOrDefault("model"), message: "Anthropic rejected the API key. Check the key in Settings." });
      return;
    }
    throw error;
  }
}));
