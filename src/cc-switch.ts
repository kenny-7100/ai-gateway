import Database from 'better-sqlite3';
import { parse } from 'smol-toml';
import { join } from 'node:path';
import type { App, Provider, ProviderResolver, Selection } from './types.js';
import { GatewayError } from './types.js';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GatewayError('invalid_provider_config');
  return value as ObjectValue;
}
function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function headers(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const entries = Object.entries(object(value));
  if (entries.some(([, v]) => typeof v !== 'string')) throw new GatewayError('invalid_provider_headers');
  return Object.fromEntries(entries.map(([k, v]) => [k.toLowerCase(), v as string]));
}
function validate(provider: Provider): Provider {
  let url: URL;
  try { url = new URL(provider.baseUrl); } catch { throw new GatewayError('invalid_provider_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new GatewayError('invalid_provider_url');
  }
  return provider;
}

/** Read-only adapter. A fresh SELECT per request makes CC Switch changes immediately visible. */
export class CCSwitchResolver implements ProviderResolver {
  private db: Database.Database;
  constructor(directory: string) {
    try {
      this.db = new Database(join(directory, 'cc-switch.db'), { readonly: true, fileMustExist: true, timeout: 2000 });
      this.db.pragma('query_only = ON');
    } catch { throw new GatewayError('cc_switch_database_unavailable'); }
  }
  resolve(app: App, selection: Selection): Provider {
    try {
      const rows = (selection.mode === 'follow'
        ? this.db.prepare('SELECT id, name, settings_config FROM providers WHERE app_type = ? AND is_current = 1').all(app)
        : this.db.prepare('SELECT id, name, settings_config FROM providers WHERE app_type = ? AND id = ?').all(app, selection.id)
      ) as { id: string; name: string; settings_config: string }[];
      if (rows.length !== 1) throw new GatewayError(rows.length ? 'ambiguous_provider_selection' : 'provider_not_found');
      const row = rows[0]!;
      const config = object(JSON.parse(row.settings_config));
      let baseUrl: string | undefined;
      let authHeaders: Record<string, string> = {};
      if (app === 'claude') {
        const env = object(config.env);
        baseUrl = string(env.ANTHROPIC_BASE_URL) ?? 'https://api.anthropic.com';
        const token = string(env.ANTHROPIC_AUTH_TOKEN);
        const key = string(env.ANTHROPIC_API_KEY);
        if (token) authHeaders.authorization = `Bearer ${token}`;
        else if (key) authHeaders['x-api-key'] = key;
        else throw new GatewayError('provider_api_credentials_missing');
      } else {
        const toml = string(config.config);
        if (!toml) throw new GatewayError('invalid_provider_config');
        const parsed = object(parse(toml));
        const selected = string(parsed.model_provider) ?? 'openai';
        const providers = parsed.model_providers === undefined ? {} : object(parsed.model_providers);
        const provider = providers[selected] === undefined ? {} : object(providers[selected]);
        baseUrl = string(provider.base_url) ?? (selected === 'openai' ? 'https://api.openai.com/v1' : undefined);
        authHeaders = headers(provider.http_headers);
        for (const [name, variable] of Object.entries(headers(provider.env_http_headers))) {
          const value = process.env[variable];
          if (!value) throw new GatewayError('provider_environment_missing');
          authHeaders[name] = value;
        }
        const auth = config.auth === undefined ? {} : object(config.auth);
        const envKey = string(provider.env_key);
        const key = (envKey ? process.env[envKey] : undefined)
          ?? string(provider.experimental_bearer_token) ?? string(auth.OPENAI_API_KEY);
        if (key) authHeaders.authorization = `Bearer ${key}`;
        if (!key && !Object.keys(authHeaders).length) throw new GatewayError('provider_api_credentials_missing');
      }
      if (!baseUrl) throw new GatewayError('provider_base_url_missing');
      return validate({ id: row.id, name: row.name, baseUrl, headers: authHeaders });
    } catch (error) {
      // Never propagate JSON/TOML/database parser errors: they can quote credential-bearing input.
      if (error instanceof GatewayError) throw error;
      throw new GatewayError('provider_config_unavailable');
    }
  }
  close(): void { this.db.close(); }
}
