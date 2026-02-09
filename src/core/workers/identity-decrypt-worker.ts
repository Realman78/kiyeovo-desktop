import { parentPort } from 'worker_threads';
import { scrypt } from '@noble/hashes/scrypt.js';
import { gcm } from '@noble/ciphers/aes.js';

interface ScryptParams {
  N: number
  r: number
  p: number
  dkLen: number
}

interface IdentityDecryptWorkerRequest {
  password: Uint8Array
  salt: Uint8Array
  nonce: Uint8Array
  encryptedData: Uint8Array
  scryptParams: ScryptParams
}

if (!parentPort) {
  throw new Error('Identity decrypt worker must be run as a worker thread');
}

parentPort.on('message', (request: IdentityDecryptWorkerRequest) => {
  let passwordBytes: Uint8Array | null = null;
  let key: Uint8Array | null = null;
  let decrypted: Uint8Array | null = null;

  try {
    passwordBytes = new Uint8Array(request.password);
    key = scrypt(passwordBytes, request.salt, request.scryptParams);

    const aes = gcm(key, request.nonce);
    decrypted = aes.decrypt(request.encryptedData);

    parentPort?.postMessage({
      ok: true,
      decrypted: Buffer.from(decrypted),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to decrypt identity';
    parentPort?.postMessage({
      ok: false,
      error: message,
    });
  } finally {
    if (passwordBytes) passwordBytes.fill(0);
    if (key) key.fill(0);
    if (decrypted) decrypted.fill(0);
  }
});
