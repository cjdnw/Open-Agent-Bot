/** Strip secrets from objects before any quota artifact is written or returned. */
const SENSITIVE_VALUE =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|ck_[A-Za-z0-9_-]{16,}|ak_[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,})\b/i;

/** Allow boolean/status fields that merely mention auth/secret. */
const SAFE_STATUS_KEYS = /^(auth_present|auth_mode|authenticated|secrets_exported|has_auth)$/i;

export function isSensitiveKey(key) {
  const k = String(key ?? "");
  if (SAFE_STATUS_KEYS.test(k)) return false;
  return /(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|www-authenticate|bearer|cookie|password|private[_-]?key|client_secret|^token$|secret$|credentials?$|session[_-]?id$)/i.test(
    k,
  );
}

export function scrubString(value) {
  if (typeof value !== "string") return value;
  return value.replace(SENSITIVE_VALUE, "[REDACTED]");
}

export function sanitize(value, depth = 0) {
  if (depth > 12) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (isSensitiveKey(key)) continue;
      out[key] = sanitize(child, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function assertNoSecrets(payload, label = "payload") {
  const raw = JSON.stringify(payload);
  if (SENSITIVE_VALUE.test(raw)) {
    throw new Error(`${label} still contains secret-shaped values after sanitize`);
  }
  for (const key of Object.keys(payload ?? {})) {
    if (isSensitiveKey(key)) throw new Error(`${label} contains sensitive key: ${key}`);
  }
}
