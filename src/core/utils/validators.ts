export function validateUsername(username: string): boolean {
    // Allow alphanumeric, underscore, hyphen, dot (reasonable for usernames)
    // Length: 1-32 characters
    const usernameRegex = /^[a-zA-Z0-9_-]{1,32}$/;

    if (!usernameRegex.test(username)) {
        console.log('Invalid username format. Use only alphanumeric characters, underscore or hyphen (max 32 chars).');
        return false;
    }

    return true;
}

export function validateFileId(fileId: string): boolean {
    // UUIDs are typically 36 characters with hyphens
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!uuidRegex.test(fileId)) {
        console.log('Invalid file ID format.');
        return false;
    }

    return true;
}

export function validateMessageLength(message: string, maxLength: number = 1024): boolean {
    if (message.length > maxLength) {
        console.log(`Message too long (${message.length} chars, max ${maxLength} chars)`);
        return false;
    }

    return true;
}

export function decodeBase64Strict(value: string): Uint8Array | null {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length % 4 !== 0) return null;
    if (!/^[A-Za-z0-9+\/]+={0,2}$/.test(trimmed)) return null;
    try {
      const decoded = Buffer.from(trimmed, "base64");
      if (decoded.length === 0) return null;
      if (decoded.toString("base64") !== trimmed) return null;
      return decoded;
    } catch {
      return null;
    }
  }