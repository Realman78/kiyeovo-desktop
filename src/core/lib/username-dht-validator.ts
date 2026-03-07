import { USERNAME_DHT_PREFIX } from '../constants.js';
import type { UserRegistration } from '../types.js';
import { hashUsingSha256 } from '../utils/crypto.js';
import {
  canonicalUsernameRegistrationPayloadJson,
  isUsernameRegistrationRecord,
  verifyUsernameRegistrationSignature,
} from './username-record.js';

type UsernameKeyKind = 'by-name' | 'by-peer';

function parseUsernameKey(key: Uint8Array): { kind: UsernameKeyKind; hash: string } {
  const keyStr = new TextDecoder().decode(key);
  if (!keyStr.startsWith(`${USERNAME_DHT_PREFIX}/`)) {
    throw new Error('Invalid username key prefix');
  }

  // ['', 'kiyeovo-username', 'by-name|by-peer', '<hash>']
  const parts = keyStr.split('/');
  if (parts.length !== 4) {
    throw new Error(`Invalid username key format: expected 4 parts, got ${parts.length}`);
  }

  const kind = parts[2];
  const hash = parts[3];
  if ((kind !== 'by-name' && kind !== 'by-peer') || !hash) {
    throw new Error('Invalid username key kind/hash');
  }

  return { kind, hash };
}

function verifyKeyBinding(kind: UsernameKeyKind, hash: string, registration: UserRegistration): boolean {
  if (kind === 'by-name') {
    return hashUsingSha256(registration.username) === hash;
  }
  return hashUsingSha256(registration.peerID) === hash;
}

function parseRegistration(value: Uint8Array): UserRegistration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(value));
  } catch {
    throw new Error('Invalid username record JSON');
  }

  if (!isUsernameRegistrationRecord(parsed)) {
    throw new Error('Invalid username registration schema');
  }
  if (!verifyUsernameRegistrationSignature(parsed)) {
    throw new Error('Invalid username registration signature');
  }

  return parsed;
}

export async function usernameRegistrationValidator(
  key: Uint8Array,
  value: Uint8Array,
): Promise<void> {
  console.log("username validator")
  const { kind, hash } = parseUsernameKey(key);
  const registration = parseRegistration(value);
  if (!verifyKeyBinding(kind, hash, registration)) {
    throw new Error('Username registration key binding mismatch');
  }
  console.log("validator passed")
}

export function usernameRegistrationSelector(
  key: Uint8Array,
  records: Uint8Array[],
): number {
  if (records.length <= 1) return 0;

  let parsedKey: { kind: UsernameKeyKind; hash: string } | null = null;
  try {
    parsedKey = parseUsernameKey(key);
  } catch {
    return 0;
  }

  let bestIndex = 0;
  let bestTimestamp = -1;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    try {
      const registration = parseRegistration(record);
      if (!verifyKeyBinding(parsedKey.kind, parsedKey.hash, registration)) continue;
      if (registration.timestamp > bestTimestamp) {
        bestTimestamp = registration.timestamp;
        bestIndex = i;
      }
    } catch {
      continue;
    }
  }

  return bestIndex;
}

export async function usernameRegistrationValidateUpdate(
  key: Uint8Array,
  existing: Uint8Array,
  incoming: Uint8Array,
): Promise<void> {
  console.log("Started")
  const keyStr = new TextDecoder().decode(key);
  const { kind, hash } = parseUsernameKey(key);
  let existingRegistration: UserRegistration;
  try {
    existingRegistration = parseRegistration(existing);
    if (!verifyKeyBinding(kind, hash, existingRegistration)) {
      // Existing data is malformed for this key; allow valid incoming replacement.
      console.warn(`[USERNAME-VALIDATOR][ALLOW_REPLACE] reason=existing_key_binding_mismatch key=${keyStr}`);
      return;
    }
  } catch (err: unknown) {
    // Existing data is malformed for this key; allow valid incoming replacement.
    const errText = err instanceof Error ? err.message : String(err);
    console.warn(`[USERNAME-VALIDATOR][ALLOW_REPLACE] reason=existing_parse_invalid key=${keyStr} err=${errText}`);
    return;
  }

  const incomingRegistration = parseRegistration(incoming);
  if (!verifyKeyBinding(kind, hash, incomingRegistration)) {
    console.warn(
      `[USERNAME-VALIDATOR][REJECT] reason=incoming_key_binding_mismatch key=${keyStr} incomingPeer=${incomingRegistration.peerID} incomingUsername=${incomingRegistration.username}`
    );
    throw new Error('stale record rejected');
  }

  if (incomingRegistration.timestamp < existingRegistration.timestamp) {
    console.warn(
      `[USERNAME-VALIDATOR][REJECT] reason=timestamp_older key=${keyStr} existingTs=${existingRegistration.timestamp} incomingTs=${incomingRegistration.timestamp} existingPeer=${existingRegistration.peerID} incomingPeer=${incomingRegistration.peerID}`
    );
    throw new Error('stale record rejected');
  }

  if (incomingRegistration.timestamp === existingRegistration.timestamp) {
    const existingRaw = canonicalUsernameRegistrationPayloadJson(existingRegistration);
    const incomingRaw = canonicalUsernameRegistrationPayloadJson(incomingRegistration);
    if (incomingRaw !== existingRaw) {
      console.warn(
        `[USERNAME-VALIDATOR][REJECT] reason=same_timestamp_payload_mismatch key=${keyStr} ts=${incomingRegistration.timestamp} existingPeer=${existingRegistration.peerID} incomingPeer=${incomingRegistration.peerID}`
      );
      throw new Error('stale record rejected');
    }
  }

  const existingKind = existingRegistration.kind ?? 'active';
  if (existingKind !== 'released') {
    const sameOwner = incomingRegistration.peerID === existingRegistration.peerID
      && incomingRegistration.signingPublicKey === existingRegistration.signingPublicKey;
    if (!sameOwner) {
      console.warn(
        `[USERNAME-VALIDATOR][REJECT] reason=owner_mismatch key=${keyStr} existingPeer=${existingRegistration.peerID} incomingPeer=${incomingRegistration.peerID} existingKind=${existingKind}`
      );
      throw new Error('stale record rejected');
    }
  }
  console.log(
    `DHT validator: accepted write to ${keyStr}... with`, incomingRegistration
  );
}
