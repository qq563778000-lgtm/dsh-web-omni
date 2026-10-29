import { existsSync } from 'fs';
import { resolve } from 'path';
import { config } from 'dotenv';
import { appRootPath } from './runtime-paths.js';
import { applyConfigToProcessEnv, loadConfig } from '../services/config-store.js';

let loaded = false;
let resolvedEnvPath = null;

function unique(paths) {
  return [...new Set(paths.filter(Boolean))];
}

function candidateEnvPaths() {
  const resourcePath = process.resourcesPath;
  return unique([
    process.env.ZHI2API_ENV_PATH,
    resolve(process.cwd(), '.env'),
    appRootPath('.env'),
    resourcePath ? resolve(resourcePath, '.env') : null,
    resourcePath ? resolve(resourcePath, 'app', '.env') : null,
  ]);
}

export function loadEnvironment() {
  if (loaded) return resolvedEnvPath;
  loaded = true;

  for (const envPath of candidateEnvPaths()) {
    if (!existsSync(envPath)) continue;
    config({ path: envPath });
    resolvedEnvPath = envPath;
    loadConfig({ force: true });
    applyConfigToProcessEnv();
    return resolvedEnvPath;
  }

  resolvedEnvPath = appRootPath('.env');
  config({ path: resolvedEnvPath });
  loadConfig({ force: true });
  applyConfigToProcessEnv();
  return resolvedEnvPath;
}

export function getEnvironmentPath() {
  return loadEnvironment();
}

export function isPromptInjectionEnabled() {
  const raw = process.env.ENABLE_PROMPT_INJECTION;
  if (raw == null || raw === '') return true;
  return !['false', '0', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

loadEnvironment();
