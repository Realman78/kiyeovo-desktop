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